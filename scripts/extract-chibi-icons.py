#!/usr/bin/env python3
"""Extract official SD character thumbnails, preserving their original alpha."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT.parent
TOOLKIT = WORK / 'HoshimiToolkit'
sys.path.insert(0, str(TOOLKIT))


def extract(name, manifest):
    import UnityPy
    from src.config import UNITY_VERSION
    from src.decrypt import crypt_by_string
    UnityPy.config.FALLBACK_UNITY_VERSION = UNITY_VERSION
    item = next(x for x in manifest['assetBundleList'] if x['name'] == name)
    source = TOOLKIT / 'cache/asset/image' / name
    origin = 'local-cache'
    if source.exists():
        raw = source.read_bytes()
    else:
        import requests
        url = manifest['urlFormat'].format(v=item['uploadVersionId'], type='assetbundle',
                                          o=item['objectName'], g=item['generation'])
        if not url.startswith('https://'):
            raise ValueError('Expected HTTPS manifest source')
        response = requests.get(url, timeout=(15, 60))
        response.raise_for_status()
        raw = response.content
        origin = 'official-manifest-download'
    if len(raw) != item['size'] or hashlib.md5(raw).hexdigest() != item['md5']:
        raise ValueError(f'Checksum mismatch: {name}')
    if not source.exists():
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(raw)
    decoded = raw if raw.startswith(b'UnityFS') else crypt_by_string(raw, name, 0, 0, min(256, len(raw)))
    env = UnityPy.load(decoded)
    textures = [obj.read() for obj in env.objects if obj.type.name == 'Texture2D']
    texture = next(t for t in textures if t.m_Name == name)
    picture = texture.image.convert('RGBA')
    cached = TOOLKIT / 'cache/image/Texture2D' / (name + '.png')
    picture.save(cached)
    return picture, item, source, origin


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidates', action='store_true')
    parser.add_argument('--full-portrait', action='store_true', help='Use the complete SD face/half-body portrait family')
    args = parser.parse_args()
    manifest = json.loads((TOOLKIT / 'cache/OctoManifest.json').read_text())
    if args.candidates:
        for name in ('img_chr_icon_ktn', 'img_chr_thumb_sd_ktn'):
            picture, _, _, _ = extract(name, manifest)
            print(name, picture.size, flush=True)
        return
    catalog = json.loads((ROOT / 'public/data/catalog.json').read_text())
    out = ROOT / 'public/images/characters' / ('sd' if args.full_portrait else 'chibi')
    out.mkdir(parents=True, exist_ok=True)
    records = []
    for character in catalog['characters']:
        name = ('img_chr_thumb_sd_' if args.full_portrait else 'img_chr_icon_') + character['id']
        picture, item, source, origin = extract(name, manifest)
        target = out / (character['id'] + '.png')
        picture.save(target, optimize=True)
        records.append({
            'id': character['id'], 'name': character['name'], 'assetName': name,
            'output': str(target.relative_to(ROOT)), 'sourceBundle': str(source.relative_to(WORK)),
            'sourceType': origin, 'manifestRevision': manifest['revision'],
            'sourceMd5': item['md5'], 'objectName': item['objectName'],
            'generation': item['generation'], 'uploadVersionId': item['uploadVersionId'],
            'dimensions': list(picture.size), 'mode': picture.mode,
            'alphaExtrema': list(picture.getchannel('A').getextrema()),
            'outputSha256': hashlib.sha256(target.read_bytes()).hexdigest(),
        })
        print(character['id'], picture.size, flush=True)
    report = ROOT / 'reports' / ('sd-portrait-assets.json' if args.full_portrait else 'chibi-assets.json')
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps({'description': 'Official game SD half-body portraits, kept complete without cropping or resizing.' if args.full_portrait else 'Official game transparent SD head icons (img_chr_icon), extracted without cropping or resizing. The img_chr_thumb_sd family is a different opaque half-body portrait and is not used.',
                                 'characters': records}, ensure_ascii=False, indent=2) + '\n')
    print(f'Exported {len(records)} icons; report: {report}')


if __name__ == '__main__':
    main()
