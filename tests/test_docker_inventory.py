from collections import Counter
from contextlib import redirect_stdout
import io
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import boto3
from botocore.stub import Stubber

from idoly_story_index.publish import publish, upload_batch
from idoly_story_index.r2_inventory import inventory_for, verification_prefixes


def media_key(number):
    return f'media/{number % 256:02x}{number:062x}/voice.flac'


class FakeS3:
    def __init__(self, objects=None):
        self.objects = dict(objects or {})
        self.listings = []
        self.returned = 0
        self.uploads = []
        self.writes = []
        self.lock = threading.Lock()

    def get_paginator(self, operation):
        if operation != 'list_objects_v2':
            raise AssertionError(operation)
        return self

    def paginate(self, **kwargs):
        if kwargs.get('PaginationConfig') != {'PageSize': 1000}:
            raise AssertionError('Expected explicit page size')
        with self.lock:
            self.listings.append(kwargs['Prefix'])
            items = [{'Key': key, 'Size': size} for key, size in sorted(self.objects.items())
                     if key.startswith(kwargs['Prefix'])]
            self.returned += len(items)
        for offset in range(0, max(1, len(items)), 1000):
            yield {'Contents': items[offset:offset + 1000]}

    def upload_file(self, path, bucket, key, **kwargs):
        with self.lock:
            self.objects[key] = Path(path).stat().st_size
            self.uploads.append(key)
        kwargs['Callback'](Path(path).stat().st_size)

    def head_object(self, **kwargs):
        raise AssertionError('Per-file HEAD forbidden')

    def put_object(self, **kwargs):
        self.writes.append(kwargs)


class InventoryTests(unittest.TestCase):
    def test_real_sdk_paginates_with_page_size_and_continuation_token(self):
        s3 = boto3.client('s3', region_name='auto', endpoint_url='https://r2.invalid',
                          aws_access_key_id='test', aws_secret_access_key='test')
        key1, key2 = media_key(1), media_key(2)
        with Stubber(s3) as stub:
            stub.add_response('list_objects_v2', {
                'IsTruncated': True, 'NextContinuationToken': 'next',
                'Contents': [{'Key': 'prefix/' + key1, 'Size': 7}]},
                {'Bucket': 'bucket', 'Prefix': 'prefix/media/', 'MaxKeys': 1000})
            stub.add_response('list_objects_v2', {
                'IsTruncated': False, 'Contents': [{'Key': 'prefix/' + key2, 'Size': 9}]},
                {'Bucket': 'bucket', 'Prefix': 'prefix/media/', 'MaxKeys': 1000, 'ContinuationToken': 'next'})
            self.assertEqual(inventory_for(s3, 'bucket', 'prefix', {key1: None, key2: None}), {key1: 7, key2: 9})
            stub.assert_no_pending_responses()

    def test_large_inventory_uses_disjoint_prefixes_with_bounded_concurrency(self):
        barrier = threading.Barrier(4)
        class ParallelS3(FakeS3):
            active = peak = started = 0
            def paginate(self, **kwargs):
                with self.lock:
                    self.active += 1
                    self.started += 1
                    self.peak = max(self.peak, self.active)
                    first_wave = self.started <= 4
                try:
                    if first_wave:
                        barrier.wait(timeout=3)
                    yield from super().paginate(**kwargs)
                finally:
                    with self.lock:
                        self.active -= 1
        jobs = {media_key(n): None for n in range(16384)}
        s3 = ParallelS3({'prefix/' + key: 12 for key in jobs})
        result = inventory_for(s3, 'bucket', 'prefix', jobs, workers=8)
        self.assertEqual(dict.fromkeys(jobs, 12), result)
        self.assertEqual(s3.peak, 4)
        self.assertEqual(len(s3.listings), 16)
        self.assertEqual(s3.returned, len(jobs))
        self.assertEqual(result.counts['media/'], len(jobs))

    def test_sparse_uploads_only_rescan_relevant_hash_prefixes(self):
        old = {'prefix/' + media_key(n): 12 for n in range(16384)}
        s3 = FakeS3(old)
        new_keys = [media_key(100096), media_key(100224)]
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'voice.flac'; path.write_bytes(b'fLaC-test')
            jobs = {key: (path, key.split('/')[1]) for key in new_keys}
            upload_batch(s3, 'bucket', 'prefix', jobs, 'test', workers=2)
            self.assertEqual(set(s3.uploads), {'prefix/' + key for key in new_keys})
            self.assertEqual(s3.listings[0], 'prefix/media/')
            self.assertEqual(set(s3.listings[1:]), {'prefix/media/00', 'prefix/media/80'})
            self.assertLess(s3.returned - len(old), 150)
            # Already-present objects need no upload or post-upload listing.
            s3.listings.clear(); s3.uploads.clear()
            upload_batch(s3, 'bucket', 'prefix', jobs, 'repeat', workers=2)
            self.assertFalse(s3.uploads)
            self.assertEqual(s3.listings, ['prefix/media/'])

    def test_widespread_uploads_merge_prefixes_to_avoid_more_requests(self):
        s3 = FakeS3({'prefix/' + media_key(n): 12 for n in range(8192)})
        jobs = {media_key(n): None for n in range(100096, 100352)}
        inventory = inventory_for(s3, 'bucket', 'prefix', jobs)
        self.assertEqual(verification_prefixes(jobs, inventory), ['media/'])

    def test_verification_plan_covers_every_key_once_and_never_costs_more_than_full_scan(self):
        jobs = {media_key(n): None for n in range(8192)}
        s3 = FakeS3({'prefix/' + key: 3 for key in jobs})
        inventory = inventory_for(s3, 'bucket', 'prefix', jobs)
        for amount in (1, 5, 30, 80, 256, 1024):
            pending = {media_key(100096 + n): None for n in range(amount)}
            prefixes = verification_prefixes(pending, inventory)
            keys = [*jobs, *pending]
            counts = Counter(part for key in keys for part in prefixes if key.startswith(part))
            self.assertTrue(all(sum(key.startswith(part) for part in prefixes) == 1 for key in pending))
            self.assertLessEqual(sum(max(1, (counts[part] + 999)//1000) for part in prefixes), (len(keys) + 999)//1000)

    def test_legacy_and_release_objects_keep_exact_root_boundaries(self):
        jobs = {'releases/new/maps/a.json': None, 'downloads/file.tar.gz': None, 'media/legacy/audio': None}
        s3 = FakeS3({'prefix/' + key: 3 for key in jobs} | {'prefix/releases/newer/private': 4})
        inventory = inventory_for(s3, 'bucket', 'prefix', jobs)
        self.assertEqual(inventory, dict.fromkeys(jobs, 3))
        self.assertNotIn('releases/newer/', inventory.counts)
        self.assertEqual(verification_prefixes(jobs, inventory), sorted(['releases/new/', 'downloads/', 'media/']))

    def test_heartbeat_continues_while_page_request_waits(self):
        heartbeat = threading.Event()
        lines = []
        def log(message, **kwargs):
            lines.append(message)
            if len(lines) == 2:
                heartbeat.set()
        class SlowS3(FakeS3):
            def paginate(self, **kwargs):
                if not heartbeat.wait(2):
                    raise AssertionError('No listing heartbeat during network wait')
                yield {'Contents': [], 'ResponseMetadata': {'RetryAttempts': 2}}
        with patch('idoly_story_index.r2_inventory.LOG_INTERVAL', 0.01), patch('builtins.print', side_effect=log):
            inventory_for(SlowS3(), 'bucket', 'prefix', {media_key(1): None})
        self.assertIn('pages=0', lines[1])
        self.assertIn('complete', lines[-1])
        self.assertIn('retries=2', lines[-1])

    def test_listing_errors_propagate_and_report_failure(self):
        class BrokenS3(FakeS3):
            def paginate(self, **kwargs):
                raise RuntimeError('unavailable')
        output = io.StringIO()
        with redirect_stdout(output), self.assertRaisesRegex(RuntimeError, 'unavailable'):
            inventory_for(BrokenS3(), 'bucket', 'prefix', {media_key(1): None})
        self.assertIn('failed', output.getvalue())

    def test_empty_jobs_do_not_query_r2(self):
        s3 = FakeS3()
        self.assertEqual(inventory_for(s3, 'bucket', 'prefix', {}), {})
        self.assertFalse(s3.listings)

    def test_missing_or_truncated_upload_never_switches_current_pointer(self):
        for mode in ('missing', 'truncated'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                class IncompleteS3(FakeS3):
                    def upload_file(self, path, bucket, key, **kwargs):
                        if mode == 'truncated':
                            self.objects[key] = Path(path).stat().st_size - 1
                root = Path(temp); stage = root/'release'
                (stage/'media').mkdir(parents=True)
                (stage/'media/voice.flac').write_bytes(b'fLaC-test')
                s3 = IncompleteS3()
                with self.assertRaisesRegex(ValueError, 'size verification failed'):
                    publish(s3, 'bucket', 'prefix', stage, {'versions': []}, 'etag', root)
                self.assertFalse(s3.writes)


if __name__ == '__main__':
    unittest.main()
