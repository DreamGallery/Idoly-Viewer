"""Export official group logos linked by CharacterGroup.assetId."""
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('chibi_assets', ROOT/'scripts/extract-chibi-icons.py')
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)
manifest = json.loads((assets.TOOLKIT/'cache/OctoManifest.json').read_text())
groups = json.loads((ROOT.parent/'Idoly-localify/.analysis/master-fetch-full/CharacterGroup.json').read_text())
output = ROOT/'public/images/groups'
output.mkdir(parents=True, exist_ok=True)
records = []
color_records = []
color_output = ROOT/'public/images/groups/color'
color_output.mkdir(parents=True, exist_ok=True)
bundle_names = {item['name'] for item in manifest['assetBundleList']}
for group in groups:
    name = 'img_group_logo_' + group['assetId']
    picture, item, _, origin = assets.extract(name, manifest)
    picture.save(output/(group['id']+'.png'), optimize=True)
    records.append({'id':group['id'], 'asset':name, 'md5':item['md5'],
                    'dimensions':list(picture.size), 'source':origin})
    print(name, picture.size, flush=True)
    color_name = 'img_group_icon_' + group['assetId']
    if color_name in bundle_names:
        color_picture, color_item, _, color_origin = assets.extract(color_name, manifest)
        color_picture.save(color_output/(group['id']+'.png'), optimize=True)
        color_records.append({'id':group['id'], 'asset':color_name, 'md5':color_item['md5'],
                              'dimensions':list(color_picture.size), 'source':color_origin})
(ROOT/'reports/group-logos.json').write_text(json.dumps({'revision':manifest['revision'], 'groups':records}, ensure_ascii=False, indent=2)+'\n')
(ROOT/'reports/group-color-icons.json').write_text(json.dumps({'revision':manifest['revision'], 'groups':color_records}, ensure_ascii=False, indent=2)+'\n')
