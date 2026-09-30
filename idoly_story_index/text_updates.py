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


def text_changes(source, revision, folders=('CSV',)):
    # Pin history to the same source revision as the published text snapshot.
    output = subprocess.check_output([
        'git', '-C', str(source), '-c', 'core.quotepath=false', 'log',
        '--format=CHANGE:%ct:%H', '--name-status', '--no-renames',
        revision, '--', *folders,
    ], text=True)
    changes, current = {}, None
    for line in output.splitlines():
        if line.startswith('CHANGE:'):
            _, timestamp, commit = line.split(':')
            current = {'at': int(timestamp) * 1000, 'commit': commit}
        elif current and '\t' in line:
            status, path = line.split('\t', 1)
            if any(path.startswith(folder + '/') for folder in folders) and path.endswith('.csv') and status in ('A', 'M'):
                if path not in changes or current['at'] > changes[path]['at']:
                    changes[path] = {**current, 'kind': 'added' if status == 'A' else 'modified'}
    return changes


def build_updates(source: Path, translations: Path, catalog, nodes, story_media, history_cache=None):
    history_source, revision = matching_history(source, catalog, history_cache) if history_cache else (source, catalog['provenance']['sourceCommit'])
    changes = text_changes(history_source, revision)
    translation_revision = catalog['provenance']['translationCommit']
    translation_changes = text_changes(translations, translation_revision, ('story/ai', 'story/human', 'story/reviewed'))
    items = []
    for story in catalog['stories']:
        sid = story['id']
        # Known event supplements share the same resolved visibility as the directory.
        pending = not story_media[sid]['indexVisible']
        candidates = []
        for origin, repo, commit_revision, history, prefixes in [
            ('原文', 'Hoshimi-Adv', revision, changes, ('CSV/',)),
            ('译文', 'Idoly-localify-translations', translation_revision, translation_changes, ('story/reviewed/', 'story/human/', 'story/ai/')),
        ]:
            for prefix in prefixes:
                path = prefix + story['path']
                if path in history:
                    candidates.append({**history[path], 'origin': origin, 'repo': repo, 'revision': commit_revision, 'path': path})
        if not candidates and not pending:
            continue
        change = max(candidates, key=lambda item: item['at']) if candidates else {
            'at': None, 'kind': None, 'commit': None, 'path': 'CSV/' + story['path'],
            'repo': 'Hoshimi-Adv', 'origin': '原文', 'revision': revision,
        }
        group_id = story_media[sid]['group']
        key, labels, images, portrait = group_id, [], [], False
        while key:
            node = nodes[key]
            if node['parent'] is not None:
                labels.append(node['label'])
            if not images and node['images']:
                images = node['images']
                portrait = node.get('portraitCover', False)
            key = node['parent']
        items.append({
            'script_id': sid, 'entry_id': sid, 'title': story['title'],
            'group_id': group_id, 'group_title': ' · '.join(reversed(labels)),
            'category_id': 'event' if story['category'] == 'love' else story['category'],
            'character_ids': story['characters'], 'pending': pending,
            'images': images, 'portrait_cover': portrait,
            'csv_path': change['path'], 'line_count': story['lines'],
            'origin': change['origin'], 'repo': change['repo'], 'revision': change['revision'],
            'updated_at': change['at'], 'change_kind': change['kind'], 'commit': change['commit'],
        })
    items.sort(key=lambda row: (-(row['updated_at'] or 0), row['script_id']))
    translation_parents = subprocess.check_output(['git', '-C', str(translations), 'rev-list', '--parents', '-n', '1', translation_revision], text=True).split()
    return {'items': items, 'source_commit': revision, 'translation_commit': translation_revision,
            'catalog_source_commit': catalog['provenance']['sourceCommit'],
            'pending_count': sum(item['pending'] for item in items),
            'source_history_available': bool(changes), 'translation_initial_import': bool(translation_changes) and len(translation_parents) == 1}
