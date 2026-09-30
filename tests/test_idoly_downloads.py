import contextlib
import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch, call

import requests

from idoly_story_index.downloads import download_bytes, download_file
from idoly_story_index.publish import Progress
from idoly_story_index.game_archive import download_raw


class Response:
    def __init__(self, status=200, chunks=(b'good',), headers=None):
        self.status_code, self.chunks, self.headers = status, chunks, headers or {}
        self.closed = False
    def __enter__(self): return self
    def __exit__(self, *args): self.closed = True
    def iter_content(self, size):
        for chunk in self.chunks:
            if isinstance(chunk, Exception): raise chunk
            yield chunk
    @property
    def content(self): return b''.join(self.iter_content(1024))


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.sleep = self.enterContext(patch('idoly_story_index.downloads.time.sleep'))
        self.get = self.enterContext(patch('idoly_story_index.downloads.requests.get'))
        self.logs = io.StringIO()
        self.enterContext(contextlib.redirect_stdout(self.logs))
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.target = self.root / 'source.bundle'
    def download(self, callback=None):
        return download_file('https://example.invalid/private-url', self.target, 'test-voice',
                             size=4, md5=hashlib.md5(b'good').hexdigest(), on_download=callback)
    def test_three_retries_then_success_and_real_received_bytes(self):
        partial = Response(chunks=(b'go', requests.exceptions.ChunkedEncodingError('secret-url')))
        responses = [Response(503), requests.Timeout('secret-url'), partial, Response()]
        self.get.side_effect = responses
        counter = Progress('download', 1, mode='download')
        self.download(counter.transfer)
        self.assertEqual(self.target.read_bytes(), b'good')
        self.assertEqual(counter.bytes, 6)  # interrupted bytes plus successful transfer
        self.assertEqual(self.get.call_count, 4)
        self.assertEqual(self.sleep.call_args_list, [call(2), call(4), call(8)])
        self.assertTrue(all(r.closed for r in responses if isinstance(r, Response)))
        self.assertEqual(list(self.root.glob('*.tmp')), [])
        self.assertIn('retry 3/3', self.logs.getvalue())
        self.assertNotIn('secret-url', self.logs.getvalue())
    def test_retry_exhaustion_keeps_previous_file_and_removes_partial(self):
        self.target.write_bytes(b'previous')
        self.get.side_effect = [Response(chunks=(b'bad!',)) for _ in range(4)]
        with self.assertRaisesRegex(RuntimeError, 'after 4 attempts'):
            self.download()
        self.assertEqual(self.target.read_bytes(), b'previous')
        self.assertEqual(list(self.root.glob('*.tmp')), [])
        self.assertEqual(self.get.call_count, 4)
    def test_permanent_http_errors_do_not_retry(self):
        for status in (400, 401, 403, 404, 501):
            self.get.reset_mock(side_effect=True); self.sleep.reset_mock()
            self.get.return_value = Response(status)
            with self.assertRaisesRegex(RuntimeError, f'HTTP {status}'):
                self.download()
            self.assertEqual(self.get.call_count, 1)
            self.sleep.assert_not_called()
    def test_certificate_errors_do_not_retry_or_expose_url(self):
        self.get.side_effect = requests.exceptions.SSLError('secret-url')
        with self.assertRaisesRegex(RuntimeError, 'TLS validation error') as caught:
            self.download()
        self.assertNotIn('secret-url', str(caught.exception))
        self.sleep.assert_not_called()
    def test_rate_limit_uses_retry_after(self):
        self.get.side_effect = [Response(429, headers={'Retry-After': '12'}), Response()]
        self.assertEqual(download_bytes('https://example.invalid', 'manifest'), b'good')
        self.sleep.assert_called_once_with(12)
    def test_downloaded_progress_is_distinct_from_upload(self):
        progress = Progress('Website media download/extract', 2, mode='download')
        progress.transfer(1048576); progress.finish('completed'); progress.finish('cached'); progress.log()
        log = self.logs.getvalue()
        self.assertIn('completed=1 cached=1 failed=0', log)
        self.assertIn('downloaded=1.00 MiB', log)
        self.assertNotIn('uploaded=', log)
    def test_valid_cached_resource_makes_no_request_and_counts_no_download(self):
        checksum = hashlib.md5(b'good').hexdigest()
        cached = self.root / checksum / 'source.bundle'; cached.parent.mkdir(); cached.write_bytes(b'good')
        callback = Mock()
        item = {'name': 'voice', 'md5': checksum, 'size': 4}
        self.assertEqual(download_raw({}, 'assetBundleList', item, self.root, callback), cached)
        self.get.assert_not_called(); callback.assert_not_called()
    def test_disk_failure_is_not_retried(self):
        self.get.return_value = Response()
        with patch('idoly_story_index.downloads.os.replace', side_effect=OSError('disk full')):
            with self.assertRaisesRegex(OSError, 'disk full'): self.download()
        self.assertEqual(self.get.call_count, 1)
        self.sleep.assert_not_called()
        self.assertEqual(list(self.root.glob('*.tmp')), [])


if __name__ == '__main__': unittest.main()
