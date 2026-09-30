"""Build ordered groups and verified script/media references from local snapshots.

Uses Campus Viewer's group/membership model; game-specific master tables and
Unity audio replace Campus's master schemas and ACB cue banks. No network I/O.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

from .card_traits import card_traits
from .exclusions import confirmed_exclusions
from .text_updates import build_updates
from .index_visibility import is_indexed_story

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT.parent

def load(path):
    return json.loads(path.read_text())

def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')))
    temp.replace(path)

def birthday_group_label(kind, sequence, master_name):
    if kind == 'userhbd':
        return '玩家生日'
    year = re.search(r'(?<!\d)(20\d{2})(?!\d)', master_name or '')
    return year[1]+'年' if year else '偶像生日 · '+sequence


def event_sort_time(story_ids):
    """Original story month, not the date of a later permanent/rerun release."""
    months = []
    for sid in story_ids:
        match = re.match(r'^adv_(?:event|love)_(\d{2})(\d{2})_', sid)
        if match:
            year, month = map(int, match.groups())
            if 1 <= month <= 12:
                months.append(int(datetime(2000+year, month, 1, tzinfo=timezone.utc).timestamp()*1000))
    return min(months) if months else None


def timing(line):
    match = re.search(r'clip=(.*)\]$', line)
    if not match:
        return None
    try:
        clip = json.loads(match[1].replace('\\{', '{').replace('\\}', '}'))
        return float(clip['_startTime']), float(clip['_duration'])
    except (ValueError, KeyError):
        return None

def voice_links(script, rows, assets):
    """Associate by timeline and actor, including a cue spanning several messages.

    Never infer the next cue from CSV order; overlapping incompatible speakers
    are excluded. The browser also verifies the exact row ID, speaker and text.
    """
    lines = script.splitlines()
    messages, voices = [], []
    for row in rows:
        line = lines[int(row['id'].split(':')[0]) - 1]
        if not line.startswith('[message '):
            continue
        t = timing(line)
        if t:
            thumb = re.search(r'thumbnial=img_(?:chr|mob)_adv_([a-z]+)[_-]', line)
            messages.append((row, t, thumb[1] if thumb else None))
    for line in lines:
        if not line.startswith('[voice '):
            continue
        ref = re.search(r'\bvoice=([\w-]+)', line)
        t = timing(line)
        if not ref or not t:
            continue
        name = ref[1]
        bank = name if name in assets else name.split('-', 1)[0]
        if bank not in assets:
            continue
        actor = re.search(r'\bactorId=([a-z]+)', line)
        suffix_actor = re.search(r'-([a-z]+)\d+$', name)
        voices.append((name, bank, t, actor[1] if actor else suffix_actor[1] if suffix_actor else None))
    result = []
    for row, (start, duration), actor in messages:
        clips = []
        # A later cue replaces that actor's earlier cue even when the exported
        # duration leaves an overlapping tail. Keep independent actors for a
        # chorus, and use timeline order rather than the script's line order.
        latest_start = {}
        for _, _, (vstart, _), vactor in voices:
            if vactor and vstart < start + .08:
                latest_start[vactor] = max(vstart, latest_start.get(vactor, vstart))
        for name, bank, (vstart, vduration), vactor in voices:
            if actor and vactor and actor != vactor:
                continue
            if vactor and vstart < latest_start.get(vactor, vstart) - 1e-6:
                continue
            exact = abs(start - vstart) < .08
            continuation = vstart < start < vstart + vduration - .05 and actor and actor == vactor
            if exact or continuation:
                clips.append({'asset': name, 'bank': bank, 'url': '/api/media/voice/' + name + '.wav', 'label': name})
        if clips:
            result.append({'row_id': row['id'], 'text': row['text'], 'speaker': row['name'], 'clips': clips})
    return result

def build(master, toolkit, source, translations, output, report=ROOT/'reports/idoly-index.json', history_cache=ROOT/'.local/text-history/Hoshimi-Adv.git'):
    catalog = load(output/'catalog.json')
    excluded = confirmed_exclusions(source)
    catalog['stories']=[s for s in catalog['stories'] if not s['id'].endswith('_short') and s['id'] not in excluded]
    octo = load(toolkit/'cache/OctoManifest.json')
    assets = {x['name']: x for x in octo['assetBundleList']}
    resources = {x['name']:x for x in octo['resourceList']}
    used_videos = {}
    tables = {n: load(master/(n+'.json')) for n in ['Story', 'StoryPart', 'EventStory', 'ExtraStory', 'LoveStoryEpisode', 'Card', 'CardEvolution', 'Character', 'Skill']}
    evolving_cards = {row['cardId'] for row in tables['CardEvolution']}
    localized = {n: load(translations/'master/zh-Hans'/(n+'.json')) if (translations/'master/zh-Hans'/(n+'.json')).exists() else {} for n in tables}
    def title(n, row, field='name'):
        return localized[n].get(row['id'], {}).get(field) or row.get(field) or row['id']
    categories = {'main':'主线剧情', 'group':'组合剧情', 'bond':'羁绊剧情', 'card':'卡牌剧情', 'event':'活动剧情', 'hbd':'生日剧情'}
    nodes = {}
    def node(key, label, parent=None, image=None):
        if key not in nodes:
            nodes[key] = {'id':key, 'label':label, 'parent':parent, 'children':[], 'stories':[], 'images':[], 'videos':[]}
            if parent:
                nodes[parent]['children'].append(key)
        if image and image in assets and not nodes[key]['images']:
            nodes[key]['images'] = [image_info(image, label)]
        return key
    used_images = set()
    def image_info(asset, label):
        used_images.add(asset)
        ratio = 16/9 if asset.startswith('img_card_full_') else 4/3 if asset.startswith('img_story_parttop_') else 1 if asset.startswith('img_story_partthumb_') else 3 if asset.startswith(('img_story_event_banner_', 'img_banner_l_')) else None
        return {'asset':asset, 'url':'/api/media/image/'+asset+'.webp', 'label':label, 'aspect_ratio':ratio}
    for key, label in categories.items():
        cover={'main':'img_story_top_main','group':'img_story_top_group','bond':'img_story_top_ex','card':'img_story_top_card','event':'img_story_top_sp','hbd':'img_story_parttop_birthday-01'}[key]
        node(key, label,image=cover)
    node('event:normal', '通常', 'event')
    node('event:love', '若恋', 'event')
    chars = {c['id']:c for c in catalog['characters']}
    portrait_path=output/'character-portraits.json'
    portraits=load(portrait_path) if portrait_path.exists() else {}
    master_story = {}
    for s in tables['Story']:
        for asset in s.get('advAssetIds', []) + [x['advAssetId'] for x in s.get('branchChoices', []) if x.get('advAssetId')]:
            master_story['adv_'+asset] = s['id']
    membership = {}
    asset_membership = {}
    story_records = {s["id"]:s for s in tables["Story"]}
    # Preserve master table order, including nested chapter/route identity.
    parts = sorted(tables['StoryPart'], key=lambda p: (0 if 'original' in p['id'] else 1, p.get('order',0), p['id']))
    for part in parts:
        category = 'group' if part['type'] == 2 else 'main'
        # Main story entry cards use full parttop art; partthumb belongs to the photo picker.
        cover_prefix = 'img_story_parttop_' if category == 'main' else 'img_story_partthumb_'
        key = node(part['id'], title('StoryPart',part), category, cover_prefix+part['assetId'])
        for chapter in part['chapters']:
            ck = node(key+':'+str(chapter['chapter'])+':'+str(chapter.get('route',0)), '第 '+str(chapter['chapter'])+' 章 · '+chapter['name'], key)
            for episode in chapter['episodes']:
                membership[(category,episode['storyId'])] = (ck, episode['episode'])
                for asset in [episode['assetId']] + story_records.get(episode['storyId'],{}).get('advAssetIds',[]):
                    asset_membership[(category,'adv_'+asset)] = (ck,episode['episode'])
    for table in ['EventStory', 'ExtraStory']:
        for event in tables[table]:
            label = title(table,event,'description' if table=='EventStory' else 'name')
            candidate = event['assetId'] if event['assetId'].startswith('img_') else next((name for name in ['img_story_event_banner_'+event['assetId'], 'img_banner_l_'+event['assetId'], 'img_story_top_'+event['assetId']] if name in assets), None)
            key = node(event['id'], label, 'event:normal', candidate)
            for ep in event['episodes']:
                membership[('event',ep['storyId'])] = (key, ep['episode'])
                for asset in [ep['assetId']] + story_records.get(ep['storyId'],{}).get('advAssetIds',[]):
                    asset_membership[('event','adv_'+asset)] = (key,ep['episode'])
    owner_by_story = {}
    for character in tables["Character"]:
        for ep in character.get("companyEnjoyStories",[]):
            owner_by_story[ep["storyId"]]=character["assetId"]
    skills = {skill['id']:skill for skill in tables['Skill']}
    card_by_story = {}
    for card in tables['Card']:
        for ep in card['stories']:
            card_by_story[ep['storyId']] = card
            owner_by_story[ep['storyId']]=next((c['assetId'] for c in tables['Character'] if c['id']==card['characterId']),card['characterId'].removeprefix('char-'))
    love_by_story = {ep['storyId']:ep for ep in tables['LoveStoryEpisode']}
    for category in ['bond', 'card', 'hbd']:
        for c in catalog['characters']:
            k=node(category+':'+c['id'], c['name'], category)
            if category in ['bond','hbd'] and c['id'] in portraits:
                nodes[k]['images']=[{'url':image['url'],'label':c['name']+'·'+image['label']} for image in portraits[c['id']]['images']]
                nodes[k]['portraitCover']=True
            elif c['image']:
                nodes[k]['images']=[{'url':c['image'], 'label':c['name']}]
    prefix_members = {}
    for s in catalog['stories']:
        if s['category']=='main' and ('main',s['id']) in asset_membership:
            prefix_members.setdefault(s['id'].rsplit('_',1)[0],set()).add(asset_membership[('main',s['id'])][0])
    # Attach CSV-only supplements to the unique named event with the same CSV
    # month code. Master event IDs can name a different month (e.g. 2506/2507).
    event_month_groups = {}
    for story in catalog['stories']:
        match = re.match(r'^adv_event_(\d{4})_', story['id'])
        if not match:
            continue
        mid = story['masterId'] or master_story.get(story['id'])
        resolved = asset_membership.get(('event', story['id'])) or membership.get(('event', mid))
        if resolved and nodes[resolved[0]]['parent'] == 'event:normal':
            event_month_groups.setdefault(match[1], set()).add(resolved[0])
    spec = importlib.util.spec_from_file_location('idoly_adv', toolkit/'src/adv_csv.py')
    adv = importlib.util.module_from_spec(spec);sys.modules[spec.name]=adv;spec.loader.exec_module(adv)
    voice_plan, story_media, counts = {}, {}, Counter()
    for s in catalog['stories']:
        sid, category = s['id'], s['category']
        mid = s['masterId'] or master_story.get(sid.removesuffix('_short'))
        pieces=sid.split('_')
        if category in ['bond','card','hbd']:
            code = pieces[2] if category in ['bond','card'] else pieces[3]
            code=owner_by_story.get(mid,code)
            ckey=category+':'+code
            if ckey not in nodes:
                node(ckey, chars.get(code,{}).get('name',code),category)
            key=ckey
            if category=='card':
                card=card_by_story.get(mid)
                if card:
                    key=node(card['id'],title('Card',card),ckey,'img_card_full_1_'+card['assetId'])
                    nodes[key]['sortTime']=int(card.get('releaseDate') or 0) or None
                    nodes[key]['cardTraits']={**card_traits(card, skills), 'hasEvolution':card['id'] in evolving_cards}
                    evolves=card['id'] in evolving_cards
                    card_title=title('Card',card)
                    movie_stages=[('full',1,'觉醒前' if evolves else '')]
                    if evolves:
                        movie_stages.append(('evolution',2,'觉醒后'))
                        for image in nodes[key]['images']:
                            if image['asset']=='img_card_full_1_'+card['assetId']:
                                image['label']=card_title+'·觉醒前'
                    nodes[key]['videos']=[]
                    for movie_kind,image_stage,stage_label in movie_stages:
                        movie_base='mov_card_'+movie_kind+'_'+card['assetId']
                        for movie in [movie_base+'_1080p.mp4',movie_base+'.mp4']:
                            if movie in resources:
                                video_id=movie.removesuffix('.mp4');used_videos[video_id]=movie
                                nodes[key]['videos'].append({'url':'/api/media/video/'+movie,'label':card_title+'·'+stage_label if stage_label else '动态卡面','poster':'/api/media/image/img_card_full_'+str(image_stage)+'_'+card['assetId']+'.webp','aspect_ratio':16/9})
                                break
                    for stage in [0,1,2]:
                        asset='img_card_full_'+str(stage)+'_'+card['assetId']
                        if asset in assets and not any(x.get('asset')==asset for x in nodes[key]['images']):
                            label=card_title+('·觉醒前' if stage==1 else '·觉醒后') if evolves and stage in [1,2] else '卡面 '+str(stage)
                            nodes[key]['images'].append(image_info(asset,label))
                else:
                    key=node('_'.join(pieces[:4]),'卡牌 '+pieces[3],ckey)
            elif category=='hbd':
                label=birthday_group_label(pieces[1],pieces[2],story_records.get(mid,{}).get('name'))
                key=node(ckey+':'+pieces[1]+':'+pieces[2],label,ckey)
        elif category=='love':
            ep=love_by_story.get(mid)
            period=ep['loveId'] if ep else 'love-'+pieces[2]
            month=pieces[2]
            key=node(period,'若恋 · 20'+month[:2]+'年'+str(int(month[2:]))+'月','event:love','img_banner_l_event-'+period.replace('love-extra-','love-'))
        elif (category,sid) in asset_membership:
            key=asset_membership[(category,sid)][0]
        elif (category,mid) in membership:
            key=membership[(category,mid)][0]
        elif category=='main' and len(prefix_members.get(sid.rsplit('_',1)[0],set()))==1:
            key=next(iter(prefix_members[sid.rsplit('_',1)[0]]))
        elif category=='event':
            if pieces[2] in ['cmn','excursion']:
                parent=node('event:'+pieces[2], '惊喜通用' if pieces[2]=='cmn' else '外出剧情', 'event:normal')
                key=node(parent+':'+pieces[3],chars.get(pieces[3],{}).get('name',pieces[3]),parent)
            else:
                candidates = event_month_groups.get(pieces[2], set())
                if len(candidates) == 1:
                    parent = next(iter(candidates))
                    key = node(parent+':other', '其他剧情', parent)
                else:
                    key=node('_'.join(pieces[:4]),'活动 '+pieces[2]+' · '+pieces[3],'event:normal')
        else:
            key=node(category+':unmapped','补充剧情',category)
        nodes[key]['stories'].append(sid)
        # Exact episode thumbnails are preferred to generic character pictures.
        plain=sid.removeprefix('adv_').removesuffix('_short')
        images=[]
        for asset in ['img_story_thumb_'+plain,'img_story_episode_vert_'+plain,'img_story_event_episode_'+plain]:
            if asset in assets:
                images=[image_info(asset,'剧情预览')];break
        script=(source/'Resource'/(sid+'.txt')).read_text()
        fields=[f for f in adv.fields(script) if f.key!='name']
        rows=[{'id':adv.csv_identifier(f),'name':f.name,'text':f.source} for f in fields]
        voice=voice_links(script,rows,assets)
        for line in voice:
            for clip in line['clips']:
                voice_plan[clip['asset']]=clip['bank']
        # Still images explicitly referenced in this script, capped only in the UI.
        stills=list(dict.fromkeys(re.findall(r'\b(?:src|image|texture)=(img_[\w-]+|env_adv_2d_[\w-]+)',script)))
        for asset in stills:
            if asset in assets and not any(x['asset']==asset for x in images):
                images.append(image_info(asset,'场景预览'))
        story_media[sid]={'group':key,'images':images,'voiceLines':len(voice),'indexVisible':is_indexed_story(s,key,nodes)}
        save(output/'media'/(sid+'.json'),{'script_id':sid,'source_script_sha256':hashlib.sha256(script.encode()).hexdigest(),'images':images,'voices':{'lines':voice}})
        counts['voiceLines']+=len(voice)
        counts['storiesWithVoice']+=bool(voice)
    # A missing Card/Story row does not mean the artwork is missing. Only use
    # an unambiguous card illustration explicitly referenced by this story group.
    for key, group in nodes.items():
        if not key.startswith('adv_card_'):
            continue
        owner = key.split('_')[2]
        references = {}
        for sid in group['stories']:
            for image in story_media[sid]['images']:
                asset = image.get('asset', '')
                if asset.startswith('img_card_full_1_' + owner + '-'):
                    references.setdefault(asset, []).append(sid)
        if len(references) == 1:
            asset, scripts = next(iter(references.items()))
            group['images'] = [image_info(asset, '卡面')]
            group['coverSource'] = {'kind':'script-reference', 'scripts':scripts, 'asset':asset}
    # Prune empty master groups without losing any CSV-only entries.
    def prune(key):
        n=nodes[key];n['children']=[k for k in n['children'] if prune(k)]
        n['count']=len(n['stories'])+sum(nodes[k]['count'] for k in n['children'])
        if not n['images']:
            for sid in n['stories']:
                if story_media[sid]['images']:
                    n['images']=story_media[sid]['images'][:1];break
        return n['count']>0
    for key in categories:prune(key)
    # Keep player birthdays before all yearly idol birthday chapters.
    for key in nodes['hbd']['children']:
        nodes[key]['children'].sort(key=lambda child: ':userhbd:' not in child)
    # Sort only the top-level event/card entries; episode and supplement order stays intact.
    for parent in ['event:normal', 'event:love']:
        for key in nodes[parent]['children']:
            nodes[key]['sortTime']=event_sort_time(nodes[key]['stories'])
    active={k:v for k,v in nodes.items() if v.get('count')}
    assert sum(len(n['stories']) for n in active.values())==len(catalog['stories'])
    provenance={'masterTables':{n:hashlib.sha256((master/(n+'.json')).read_bytes()).hexdigest() for n in tables},'catalogSha256':hashlib.sha256((output/'catalog.json').read_bytes()).hexdigest(),'manifestSha256':hashlib.sha256((toolkit/'cache/OctoManifest.json').read_bytes()).hexdigest()}
    save(output/'directory.json',{'provenance':provenance,'roots':list(categories),'nodes':active,'stories':story_media,'stats':dict(counts),'revision':octo['revision']})
    save(output/'updates.json',build_updates(source,translations,catalog,active,story_media,history_cache))
    selected=used_images|set(voice_plan.values())
    selected_assets={k:assets[k] for k in sorted(selected)}
    selected_assets.update({k:resources[k] for k in used_videos.values()})
    save(output/'media-plan.json',{'revision':octo['revision'],'urlFormat':octo['urlFormat'],'assets':selected_assets,'images':sorted(used_images),'voices':voice_plan,'videos':used_videos})
    save(report,{'stories':len(catalog['stories']),'groups':len(active),'images':len(used_images),'voiceAssets':len(voice_plan),'videoAssets':len(used_videos),'stats':dict(counts)})
    print(json.dumps({'stories':len(catalog['stories']),'groups':len(active),'images':len(used_images),**counts}))

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--master',type=Path,default=WORK/'Idoly-localify/.analysis/master-fetch-full')
    p.add_argument('--toolkit',type=Path,default=WORK/'HoshimiToolkit')
    p.add_argument('--source',type=Path,default=WORK/'Hoshimi-Adv')
    p.add_argument('--translations',type=Path,default=WORK/'Idoly-localify-translations')
    p.add_argument('--output',type=Path,default=ROOT/'public/data')
    p.add_argument('--report',type=Path,default=ROOT/'reports/idoly-index.json')
    build(**vars(p.parse_args()))

if __name__=='__main__':main()
