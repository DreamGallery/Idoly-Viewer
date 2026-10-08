"""Build a reproducible, credential-free web snapshot from local repositories."""
import argparse
import csv
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT.parent
sys.path.insert(0, str(ROOT))
from idoly_story_index.exclusions import confirmed_exclusions
from idoly_story_index.translation_status import translation_status
from idoly_story_index.public_text import original_story

def digest(value):
    return hashlib.sha256(value).hexdigest()

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

def read_csv(path):
    with path.open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames != ['id', 'name', 'text', 'trans']:
            raise ValueError(f'Unexpected CSV columns: {path}')
        rows = list(reader)
        if len({r['id'] for r in rows}) != len(rows):
            raise ValueError(f'Duplicate row IDs: {path}')
        return rows

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--master', type=Path, default=WORK/'Idoly-localify/.analysis/master-fetch-full')
    parser.add_argument('--toolkit', type=Path, default=WORK/'HoshimiToolkit')
    parser.add_argument('--source', type=Path, default=WORK/'Hoshimi-Adv')
    parser.add_argument('--translations', type=Path, default=WORK/'Idoly-localify-translations')
    parser.add_argument('--output', type=Path, default=ROOT/'public/data')
    parser.add_argument('--report', type=Path, default=ROOT/'reports/data-validation.json')
    parser.add_argument('--original-only', action='store_true', help='Publish original dialogue only; keep public catalog metadata and completion counts')
    args = parser.parse_args()
    public = args.output.parent
    spec = importlib.util.spec_from_file_location('toolkit_adv', args.toolkit/'src/adv_csv.py')
    adv = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = adv
    spec.loader.exec_module(adv)
    load = lambda p: json.loads(p.read_text(encoding='utf-8'))
    names = load(args.translations/'glossary/names.json')
    tables = {n: load(args.master/(n+'.json')) for n in ['Character', 'CharacterGroup', 'Story', 'StoryPart', 'EventStory', 'ExtraStory', 'LoveStoryEpisode']}
    localized = load(args.translations/'master/zh-Hans/Story.json')
    groups = [{k: x.get(k, '') for k in ['id', 'name', 'color', 'order']} for x in tables['CharacterGroup']]
    characters = []
    seen=set()
    for c in sorted(tables['Character'], key=lambda x: x['order']):
        if c['assetId'] in seen or not c.get('characterGroupId'): continue
        seen.add(c['assetId'])
        code = c['assetId']
        image = args.toolkit/f'cache/image/Texture2D/img_chr_adv_{code}-00.png'
        if not image.exists():
            image = args.toolkit/f'cache/image/Texture2D/img_message_icon_{code}.png'
        image_url = ''
        if image.exists():
            target = public/'images/characters'/f'{code}.png'
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(image, target)
            image_url = f'/images/characters/{code}.png'
        characters.append({'id': code, 'name': names.get(c['name'], c['name']), 'originalName': c['name'], 'enName': c['enName'], 'group': c['characterGroupId'], 'color': '#'+(c.get('color') or '5678a0'), 'image': image_url})
    by_asset = {}
    for story in tables['Story']:
        assets = story.get('advAssetIds', []) + [x['advAssetId'] for x in story.get('branchChoices', []) if x.get('advAssetId')]
        for asset in assets:
            by_asset[asset] = story
    references = {}
    def walk(value, table, parent=''):
        if isinstance(value, list):
            for x in value: walk(x, table, parent)
        elif isinstance(value, dict):
            label = value.get('description') or value.get('name') or parent
            if value.get('storyId'):
                references.setdefault(value['storyId'], []).append({'table': table, 'label': parent, 'episode': value.get('episode')})
            for x in value.values():
                if isinstance(x, (dict,list)): walk(x, table, label)
    for table in ['StoryPart', 'EventStory', 'ExtraStory', 'LoveStoryEpisode']:
        walk(tables[table], table)
    index, failures, mismatches = [], [], []
    excluded = confirmed_exclusions(args.source)
    for path in sorted((args.source/'CSV').rglob('*.csv')):
        if path.stem.endswith('_short') or path.stem in excluded:
            continue
        relative = path.relative_to(args.source/'CSV').as_posix()
        sid = path.stem
        all_rows = read_csv(path)
        metadata = [r for r in all_rows if r['id'] in ['info', '译者']]
        rows = [r for r in all_rows if r['id'] not in ['info', '译者']]
        source_file = args.source/'Resource'/(sid+'.txt')
        with source_file.open(encoding='utf-8', newline='') as stream: script = stream.read()
        fields = {adv.csv_identifier(f): f for f in adv.fields(script) if f.key != 'name'}
        if set(fields) != {r['id'] for r in rows}:
            raise ValueError(f'CSV/script row mismatch: {relative}')
        candidates = {}
        for layer in ['ai', 'human', 'reviewed']:
            candidate = args.translations/'story'/layer/relative
            if candidate.exists(): candidates[layer] = {r['id']: r for r in read_csv(candidate)}
        for row in rows:
            f = fields[row['id']]
            if row['text'] != f.source or row['name'] != f.name:
                raise ValueError(f'Source text mismatch: {sid} {row["id"]}')
            row.update({'start': f.start, 'end': f.end, 'ai': '', 'human': '', 'reviewed': '', 'character': next((c['id'] for c in characters if c['originalName'] == row['name']), '')})
            for layer, translated in candidates.items():
                item = translated.get(row['id'])
                if item and item['text'] == row['text'] and item['name'] == row['name']:
                    if not args.original_only and layer == 'reviewed' and item['trans'].strip():
                        try: adv.validate_translation(f, item['trans'])
                        except ValueError as e:
                            failures.append({'story': sid, 'row': row['id'], 'layer': layer, 'message': str(e)})
                            continue
                    row[layer] = item['trans']
                elif item:
                    mismatches.append({'story': sid, 'row': row['id'], 'layer': layer})
            row['trans'] = row['reviewed'] or row['human'] or row['ai']
            if row['trans'] and not args.original_only:
                try: adv.validate_translation(f, row['trans'])
                except ValueError as e: failures.append({'story': sid, 'row': row['id'], 'message': str(e)})
        title_row = next((r for r in rows if ':title:' in r['id']), None)
        master = by_asset.get(sid.removeprefix('adv_'))
        original_title = (master or {}).get('name') or (title_row or {}).get('text') or sid
        title = localized.get((master or {}).get('id'), {}).get('name') or (None if args.original_only else (title_row or {}).get('trans')) or original_title
        if re.fullmatch(r'adv_userhbd_\d+_[a-z]+', sid):
            title = '玩家生日'
        cast = sorted({r['character'] for r in rows if r['character']})
        # Include actors present in the script even when their speaking name is abbreviated.
        cast = sorted(set(cast) | {c['id'] for c in characters if re.search(r'\[actor id='+re.escape(c['id'])+r'\b', script)})
        item = {'id': sid, 'path': relative, 'category': relative.split('/')[0], 'title': title.replace('\\n',' ').replace('\n',' '), 'originalTitle': original_title.replace('\\n',' ').replace('\n',' '), 'characters': cast, 'lines': len(rows), 'aiLines': sum(bool(r['ai']) for r in rows), 'humanLines': sum(bool(r['human']) for r in rows), 'reviewedLines': sum(bool(r['reviewed'].strip()) for r in rows), 'translationStatus': translation_status(rows), 'masterId': (master or {}).get('id'), 'references': references.get((master or {}).get('id'), []), 'sourceHash': digest(script.encode()), 'sourceFileHash': digest(source_file.read_bytes())}
        if not any(r['id'] == 'info' and r['text'] == item['sourceFileHash'] for r in metadata):
            raise ValueError(f'Source checksum mismatch: {sid}')
        payload = {**item, 'rows': rows, 'metadata': metadata, 'script': script, 'names': {r['name']: names.get(r['name'], r['name']) for r in rows if r['name']}}
        write_json(args.output/'stories'/f'{sid}.json', original_story(payload) if args.original_only else payload)
        index.append(item)
    def commit(p):
        return subprocess.check_output(['git','-C',str(p),'rev-parse','HEAD'],text=True).strip()
    provenance = {'sourceRepo': 'DreamGallery/Hoshimi-Adv', 'sourceCommit': commit(args.source), 'translationRepo': 'DreamGallery/Idoly-localify-translations', 'translationCommit': commit(args.translations), 'revision': (args.source/'revision').read_text().strip(), 'masterTables': {n: digest((args.master/(n+'.json')).read_bytes()) for n in tables}, 'toolkitParserHash': digest((args.toolkit/'src/adv_csv.py').read_bytes()), 'validationWarnings': len(failures), 'translationMismatches': len(mismatches)}
    write_json(public/'catalog/manifest.json', {'base_path':'/catalog','build_id':provenance['sourceCommit']})
    for item in index:
        write_json(public/'catalog/chapters'/f"{item['id']}.json", {'script_id':item['id'],'csv_path':item['path'],'line_count':item['lines']})
    write_json(args.output/'catalog.json', {'stories': index, 'characters': characters, 'groups': groups, 'provenance': provenance})
    write_json(args.output/'glossary.json', {'names': names, 'terms': load(args.translations/'glossary/terms.json')})
    write_json(args.report, {'provenance': provenance, 'warnings': failures, 'mismatches': mismatches, 'stories': len(index), 'rows': sum(x['lines'] for x in index), 'masterMatched': sum(bool(x['masterId']) for x in index)})
    # Remove excluded generated shards; never touch source CSV/TXT files.
    for folder in [args.output/'stories',public/'catalog/chapters',args.output/'media']:
        for stale in folder.glob('*.json'):
            if stale.stem.endswith('_short') or stale.stem in excluded:
                stale.unlink()
    print(json.dumps({'stories': len(index), 'rows': sum(x['lines'] for x in index), 'masterMatched': sum(bool(x['masterId']) for x in index), 'warnings':len(failures), 'mismatches':len(mismatches)}, ensure_ascii=False))

if __name__ == '__main__': main()
