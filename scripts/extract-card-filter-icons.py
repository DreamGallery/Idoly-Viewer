"""Extract original card attribute/role sprites from the local game APK.

Requires UnityPy and Pillow; reads local APK extraction metadata.
"""
import hashlib
import json
import zipfile
from pathlib import Path

import UnityPy

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent / 'Idoly-localify/.analysis/button-images-20260929'
OUTPUT = ROOT / 'public/images/card-filters'
NAMES = ['icon_parameter_vocal', 'icon_parameter_dance', 'icon_parameter_visual',
         'icon_scorer', 'icon_buffer', 'icon_supporter', 'icon_sp',
         'icon_scorer_thumbnail', 'icon_buffer_thumbnail', 'icon_supporter_thumbnail',
         'icon_before_evolution', 'icon_after_evolution']


def main():
    UnityPy.config.FALLBACK_UNITY_VERSION = '2022.3.57f1'
    index = json.loads((SOURCE / 'apk-images-index.json').read_text())
    OUTPUT.mkdir(parents=True, exist_ok=True)
    env = UnityPy.Environment()
    loaded = {}
    records = []
    with zipfile.ZipFile(SOURCE / 'apks/base.apk') as apk:
        def load(name):
            if name not in loaded:
                loaded[name] = env.load_file(apk.read('assets/bin/Data/' + name), name=name)
            return loaded[name]

        load('00000000000000000000000000000000')
        for name in apk.namelist():
            if name.startswith('assets/bin/Data/') and name.endswith(('.resS', '.resource')):
                load(name.split('/')[-1])
        for name in NAMES:
            row = next(row for row in index if row['name'] == name and row['type'] == 'Sprite')
            file = load(row['file'].split('/')[-1])
            obj = file.objects[row['id']]
            atlas = obj.read_typetree()['m_SpriteAtlas']
            if atlas['m_FileID']:
                load(file.externals[atlas['m_FileID'] - 1].name)
            picture = obj.read().image
            destination = OUTPUT / (name + '.png')
            picture.save(destination)
            records.append({'asset': name, 'source': row['file'], 'pathId': row['id'],
                            'dimensions': list(picture.size),
                            'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()})
            print(name, picture.size)
    report = ROOT / 'reports/card-filter-icons.json'
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps({'source': str(SOURCE / 'apks/base.apk'), 'sprites': records},
                                 ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
