"""Download the two official character-page illustrations without cropping."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://idolypride.jp'
CHARACTERS = {
    'ktn':'kotono-nagase', 'ngs':'nagisa-ibuki', 'ski':'saki-shiraishi',
    'suz':'suzu-narumiya', 'mei':'mei-hayasaka', 'skr':'sakura-kawasaki',
    'szk':'shizuku-hyodo', 'chs':'chisa-shiraishi', 'rei':'rei-ichinose',
    'hrk':'haruko-saeki', 'rui':'rui-tendo', 'yu':'yu-suzumura',
    'smr':'sumire-okuyama', 'rio':'rio-kanzaki', 'aoi':'aoi-igawa',
    'ai':'ai-komiyama', 'kkr':'kokoro-akazaki', 'kor':'fran',
    'kan':'kana', 'mhk':'miho', 'mna':'mana-nagase',
}


def download(entry):
    code, slug = entry
    page_url = BASE + '/character/' + slug + '/'
    html = urlopen(page_url, timeout=30).read().decode('utf-8')
    images = []
    for variant, label, letter in [('casual','常服','b'),('stage','演出服','a')]:
        paths = re.findall(r'src="([^"]+_main_' + letter + r'[^"/]*_pc\.png)"', html)
        if len(set(paths)) != 1:
            raise ValueError(f'{code}: ambiguous {variant} portrait: {paths}')
        source = BASE + paths[0]
        target = ROOT / 'public/images/characters/portraits' / (code + '-' + variant + '.png')
        if not target.exists():
            raw = urlopen(source, timeout=60).read()
            if not raw.startswith(b'\x89PNG\r\n\x1a\n'):
                raise ValueError('Not a PNG: ' + source)
            target.write_bytes(raw)
        raw = target.read_bytes()
        images.append({'url':'/images/characters/portraits/'+target.name, 'label':label,
                       'source':source, 'sha256':hashlib.sha256(raw).hexdigest()})
    print(code, 'ready', flush=True)
    return code, {'page':page_url, 'images':images}


if __name__ == '__main__':
    (ROOT/'public/images/characters/portraits').mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        records = dict(pool.map(download, CHARACTERS.items()))
    (ROOT/'public/data/character-portraits.json').write_text(
        json.dumps(records, ensure_ascii=False, indent=2)+'\n')
