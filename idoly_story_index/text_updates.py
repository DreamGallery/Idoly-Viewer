"""Adapt Campus Viewer's CSV commit history to IDOLY's local story catalog."""
from pathlib import Path
import subprocess
import hashlib


def matching_history(source, catalog, cache):
    """Use remote history only when every indexed CSV matches local bytes exactly.

    The optional bare cache is read-only here; no network or source checkout edits.
    It may include newer files that are absent from the current local catalog.
    """
    fallback = (source, catalog['provenance']['sourceCommit'])
    if not cache.exists():
        return fallback
    hashes = {}
    for story in catalog['stories']:
        path = 'CSV/' + story['path']
        content = (source / path).read_bytes()
        hashes[path] = hashlib.sha1(b'blob ' + str(len(content)).encode() + b'\0' + content).hexdigest()
    revisions = subprocess.check_output(['git', '-C', str(cache), 'rev-list', 'HEAD', '--', 'CSV'], text=True).splitlines()
    for revision in revisions:
        tree = subprocess.check_output(['git', '-C', str(cache), 'ls-tree', '-rz', revision, '--', 'CSV'])
        entries = {}
        for entry in tree.split(b'\0'):
            if entry:
                metadata, path = entry.split(b'\t', 1)
                entries[path.decode()] = metadata.split()[2].decode()
        if all(entries.get(path) == digest for path, digest in hashes.items()):
            return cache, revision
    return fallback


def text_changes(source, revision):
    # Pin history to the same source revision as the published text snapshot.
    output = subprocess.check_output([
        'git', '-C', str(source), '-c', 'core.quotepath=false', 'log',
        '--format=CHANGE:%ct:%H', '--name-status', '--no-renames',
        revision, '--', 'CSV',
    ], text=True)
    changes, current = {}, None
    for line in output.splitlines():
        if line.startswith('CHANGE:'):
            _, timestamp, commit = line.split(':')
            current = {'at': int(timestamp) * 1000, 'commit': commit}
        elif current and '\t' in line:
            status, path = line.split('\t', 1)
            if path.startswith('CSV/') and path.endswith('.csv') and status in ('A', 'M'):
                if path not in changes or current['at'] > changes[path]['at']:
                    changes[path] = {**current, 'kind': 'added' if status == 'A' else 'modified'}
    return changes


def build_updates(source: Path, catalog, nodes, story_media, history_cache=None):
    history_source, revision = matching_history(source, catalog, history_cache) if history_cache else (source, catalog['provenance']['sourceCommit'])
    changes = text_changes(history_source, revision)
    items = []
    for story in catalog['stories']:
        sid = story['id']
        # Known event supplements share the same resolved visibility as the directory.
        pending = not story_media[sid]['indexVisible']
        path = 'CSV/' + story['path']
        change = changes.get(path)
        if not change and not pending:
            continue
        change = change or {'at': None, 'kind': None, 'commit': None}
        group_id = story_media[sid]['group']
        key, labels, images, portrait = group_id, [], [], False
        while key:
            node = nodes[key]
            if node['parent'] is not None:
                labels.append(node['label'])
            if story['category'] == 'hbd' and node['parent'] == 'hbd':
                images = node['images']
                portrait = False
            elif not images and node['images']:
                images = node['images']
                portrait = node.get('portraitCover', False)
            key = node['parent']
        items.append({
            'script_id': sid, 'entry_id': sid, 'title': story['title'],
            'group_id': group_id, 'group_title': ' · '.join(reversed(labels)),
            'category_id': 'event' if story['category'] == 'love' else story['category'],
            'character_ids': story['characters'], 'pending': pending,
            'images': images, 'portrait_cover': portrait,
            'csv_path': path, 'line_count': story['lines'],
            'origin': '原文', 'repo': 'Hoshimi-Adv', 'revision': revision,
            'updated_at': change['at'], 'change_kind': change['kind'], 'commit': change['commit'],
        })
    items.sort(key=lambda row: (-(row['updated_at'] or 0), row['script_id']))
    return {'items': items, 'source_commit': revision,
            'catalog_source_commit': catalog['provenance']['sourceCommit'],
            'pending_count': sum(item['pending'] for item in items),
            'source_history_available': bool(changes)}
