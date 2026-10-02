"""Local music preview: MasterDB titles and Octo song/jacket resources."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import warnings

from .build import ROOT, WORK, load, save
from .downloads import download_file
from .octo_source import decrypt_bundle
from .music_index import music_index
from .textures import select_texture as select_cover


def build_catalog(root=ROOT):
    manifest = load(Path(os.environ.get('IDOLY_MUSIC_MANIFEST', WORK/'HoshimiToolkit/cache/OctoManifest.json')))
    master = load(Path(os.environ.get('IDOLY_MUSIC_MASTER', WORK/'Idoly-localify/.analysis/master-fetch-full/Music.json')))
    translated_path = WORK/'Idoly-localify-translations/master/zh-Hans/Music.json'
    translated = load(translated_path) if translated_path.exists() else {}
    catalog, plan = music_index(manifest, master, translated, local=True)
    cache = root/'.local/music'
    save(cache/'plan.json', {'urlFormat': manifest['urlFormat'], 'assets': plan['assets']})
    save(cache/'catalog.json', catalog)
    return catalog['tracks']


def materialize(kind, track_id, root=ROOT):
    cache = root/'.local/music'
    tracks = load(cache/'catalog.json')['tracks']
    if track_id not in {track['id'] for track in tracks} or kind not in ('audio', 'cover'):
        raise ValueError('Music is not indexed')
    plan = load(cache/'plan.json')
    name = ('sud_music_short_' if kind == 'audio' else 'img_music_jacket_')+track_id
    item = plan['assets'][name]
    folder = cache/item['md5']; folder.mkdir(parents=True, exist_ok=True)
    target = folder/('audio.flac' if kind == 'audio' else 'cover.webp')
    if target.is_file():
        return target
    bundle = folder/'source.bundle'
    url = plan['urlFormat']
    for key, value in {'v': item['uploadVersionId'], 'type': 'assetbundle', 'o': item['objectName'], 'g': item['generation']}.items():
        url = url.replace('{'+key+'}', str(value))
    if not bundle.is_file():
        download_file(url, bundle, name, size=item['size'], md5=item['md5'])
    raw = bundle.read_bytes()
    if len(raw) != item['size'] or hashlib.md5(raw).hexdigest() != item['md5']:
        raise ValueError('Music resource checksum mismatch')
    import UnityPy
    UnityPy.config.FALLBACK_UNITY_VERSION = os.environ.get('IDOLY_UNITY_VERSION', '2022.3.57f1')
    warnings.filterwarnings('ignore', module='UnityPy')
    env = UnityPy.load(decrypt_bundle(raw, name))
    if kind == 'cover':
        resource = select_cover(env, name)
    else:
        candidates = [obj.read() for obj in env.objects if obj.type.name == 'AudioClip']
        exact = [obj for obj in candidates if obj.m_Name in (name, name+'.wav')]
        if len(exact) != 1 and len(candidates) != 1:
            raise ValueError('Ambiguous music resource')
        resource = (exact or candidates)[0]
    with tempfile.TemporaryDirectory(dir=folder) as temporary:
        output = Path(temporary)/target.name
        if kind == 'cover':
            picture = resource.image
            picture.thumbnail((1000, 1000))
            picture.save(output, 'WEBP', quality=94)
        else:
            samples = resource.samples
            if len(samples) != 1:
                raise ValueError('Ambiguous music audio')
            wav = next(iter(samples.values()))
            if wav[:4] != b'RIFF' or wav[8:12] != b'WAVE':
                raise ValueError('Invalid decoded music')
            ffmpeg = os.environ.get('IDOLY_MUSIC_FFMPEG') or shutil.which('ffmpeg')
            if not ffmpeg:
                import imageio_ffmpeg
                ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
            subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-c:a', 'flac', '-compression_level', '8', str(output)], input=wav, check=True, timeout=120)
            if output.read_bytes()[:4] != b'fLaC':
                raise ValueError('Invalid FLAC output')
        output.chmod(0o644)
        output.replace(target)
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=['catalog', 'audio', 'cover'])
    parser.add_argument('id', nargs='?')
    args = parser.parse_args()
    if args.kind == 'catalog':
        print(f'Indexed {len(build_catalog())} game songs')
    else:
        print(materialize(args.kind, args.id))
