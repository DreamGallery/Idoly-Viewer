"""Bounded, paginated R2 inventories and scoped post-upload verification."""
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
import re
import threading
import time


PAGE_SIZE = 1000
MAX_WORKERS = 4
LOG_INTERVAL = 10
HEX = '0123456789abcdef'
HASH_DEPTH = 2
CONTENT_KEY = re.compile(r'^(media|text)/([a-f0-9]{64})/[^/]+$')


def root_prefix(key):
    parts = key.split('/')
    return '/'.join(parts[:2] if parts[0] == 'releases' else parts[:1]) + '/'


def count_prefixes(key):
    yield root_prefix(key)
    match = CONTENT_KEY.fullmatch(key)
    if match:
        for depth in range(1, HASH_DEPTH + 1):
            yield match[1] + '/' + match[2][:depth]


class Inventory(dict):
    """Keep requested sizes, but count all scanned objects for query planning."""
    def __init__(self):
        super().__init__()
        self.counts = Counter()


def listing_prefixes(jobs):
    groups = defaultdict(list)
    for key in jobs:
        groups[root_prefix(key)].append(key)
    prefixes = []
    for root, keys in sorted(groups.items()):
        # Avoid sixteen nearly empty requests for small snapshots. Large hash
        # namespaces can be scanned without sharing a continuation token.
        if len(keys) > PAGE_SIZE * len(HEX) and all(CONTENT_KEY.fullmatch(key) for key in keys):
            prefixes.extend(root + digit for digit in HEX)
        else:
            prefixes.append(root)
    return prefixes


def verification_prefixes(jobs, inventory):
    """Choose non-overlapping prefixes with the lowest estimated page count."""
    groups = defaultdict(list)
    for key in jobs:
        groups[root_prefix(key)].append(key)
    if not isinstance(inventory, Inventory):
        return sorted(groups)
    counts = inventory.counts.copy()
    for key in jobs:
        if key not in inventory:
            counts.update(count_prefixes(key))

    def choose(prefix, keys, depth):
        objects = counts[prefix]
        cost = (max(1, (objects + PAGE_SIZE - 1) // PAGE_SIZE), objects)
        if depth == HASH_DEPTH:
            return cost, [prefix]
        children = defaultdict(list)
        for key in keys:
            children[key.split('/')[1][depth]].append(key)
        parts = [choose(prefix + digit, child, depth + 1) for digit, child in sorted(children.items())]
        split_cost = (sum(part[0][0] for part in parts), sum(part[0][1] for part in parts))
        if split_cost < cost:
            return split_cost, [item for part in parts for item in part[1]]
        return cost, [prefix]

    result = []
    for root, keys in sorted(groups.items()):
        if all(CONTENT_KEY.fullmatch(key) for key in keys):
            result.extend(choose(root, keys, 0)[1])
        else:
            result.append(root)
    return result


class ListingProgress:
    def __init__(self, label, total):
        self.label, self.total = label, total
        self.pages = self.objects = self.matched = self.retries = self.done = 0
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.started = time.monotonic()

    def report(self, state='reading'):
        with self.lock:
            print(f'{self.label}: {state} | prefixes={self.done}/{self.total} pages={self.pages} '
                  f'objects={self.objects} matched={self.matched} retries={self.retries} | '
                  f'{time.monotonic() - self.started:.0f}s', flush=True)

    def page(self, objects, matched, retries):
        with self.lock:
            self.pages += 1
            self.objects += objects
            self.matched += matched
            self.retries += retries
            first = self.pages == 1
        if first:
            self.report()

    def finish(self):
        with self.lock:
            self.done += 1

    def __enter__(self):
        self.report()
        def heartbeat():
            while not self.stop.wait(LOG_INTERVAL):
                self.report()
        self.thread = threading.Thread(target=heartbeat, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, error_type, *_):
        self.stop.set()
        self.thread.join()
        self.report('failed' if error_type else 'complete')


def inventory_for(s3, bucket, prefix, jobs, *, workers=4, prefixes=None, phase='listing'):
    prefixes = listing_prefixes(jobs) if prefixes is None else prefixes
    inventory = Inventory()
    if not prefixes:
        return inventory
    namespaces = ', '.join(sorted({root_prefix(key).rstrip('/') for key in jobs}))
    with ListingProgress(f'R2: {phase} {namespaces}', len(prefixes)) as progress:
        def scan(folder):
            found = Inventory()
            remote_prefix = prefix + '/' + folder
            pages = s3.get_paginator('list_objects_v2').paginate(
                Bucket=bucket, Prefix=remote_prefix, PaginationConfig={'PageSize': PAGE_SIZE})
            for page in pages:
                items = page.get('Contents', [])
                matched = 0
                for item in items:
                    if not item['Key'].startswith(remote_prefix):
                        raise ValueError('R2 returned an object outside the requested prefix')
                    key = item['Key'][len(prefix) + 1:]
                    found.counts.update(count_prefixes(key))
                    if key in jobs:
                        found[key] = item['Size']
                        matched += 1
                progress.page(len(items), matched, page.get('ResponseMetadata', {}).get('RetryAttempts', 0))
            progress.finish()
            return found
        with ThreadPoolExecutor(max_workers=max(1, min(workers, MAX_WORKERS, len(prefixes)))) as pool:
            for found in pool.map(scan, prefixes):
                inventory.update(found)
                inventory.counts.update(found.counts)
    return inventory
