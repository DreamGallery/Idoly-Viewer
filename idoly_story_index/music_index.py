"""Build public music metadata and private media references from pinned game data."""
import re


def music_index(manifest, rows, translated=None, *, local=False):
    translated = translated or {}
    assets = {item['name']: item for item in manifest['assetBundleList'] if item.get('state') != 4}
    tracks, selected, voices, images, seen = [], {}, {}, [], set()
    featured = ['hsm-001', 'hsm-003', 'moon-001', 'sun-001', 'tri-001', 'liz-001', 'mna-001']
    for row in sorted(rows, key=lambda x: (featured.index(x['assetId']) if x['assetId'] in featured else 99, x['order'])):
        asset = row['assetId']
        audio, cover = 'sud_music_short_'+asset, 'img_music_jacket_'+asset
        if asset in seen or not re.fullmatch(r'[a-z0-9-]+', asset) or audio not in assets or cover not in assets:
            continue
        seen.add(asset)
        text = translated.get(row['id'], {})
        tracks.append({'id': asset, 'title': text.get('name') or row['name'],
                       'originalTitle': row['name'], 'artist': text.get('singer') or row['singer'],
                       'audio': f'/api/local-music/audio/{asset}.flac' if local else f'/api/media/voice/{audio}.flac',
                       'cover': f'/api/local-music/cover/{asset}.webp' if local else f'/api/media/image/{cover}.webp',
                       'version': '游戏版'})
        selected[audio], selected[cover] = assets[audio], assets[cover]
        voices[audio] = audio
        images.append(cover)
    return ({'tracks': tracks, 'revision': manifest['revision']},
            {'assets': selected, 'voices': voices, 'images': images})
