"""x86 NAS updater: GitHub text/MasterDB -> Octo media -> snapshot -> R2."""
import argparse
import csv
from concurrent.futures import ThreadPoolExecutor
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

from .build import ROOT, build, load, save
from .game_archive import prepare_archives
from .master_source import fetch_master, REPO_PATTERN
from .media import materialize
from .music_index import music_index
from .octo_source import update_manifest
from .publish import connect, digest, read_current, publish, Progress
from .downloads import download_bytes


def sync_repo(root,name,repository,branch,token):
    if not REPO_PATTERN.fullmatch(repository) or not re.fullmatch(r'[\w./-]+',branch) or branch.startswith('-'):
        raise ValueError('Invalid source repository or branch')
    root.mkdir(parents=True,exist_ok=True)
    target=root/name
    # The token is only an environment value read by askpass; never in argv,
    # remote URL, git config, publication provenance or Docker image layers.
    askpass=root/'askpass.sh'
    askpass.write_text('#!/bin/sh\ncase "$1" in *Username*) printf "%s" "x-access-token";; *) printf "%s" "$IDOLY_GITHUB_TOKEN";; esac\n')
    askpass.chmod(0o700)
    env={**os.environ,'GIT_TERMINAL_PROMPT':'0','GIT_ASKPASS':str(askpass.resolve()),'IDOLY_GITHUB_TOKEN':token}
    def git(args):
        result=subprocess.run(['git',*args],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        if result.returncode:
            raise RuntimeError(f'Git sync failed for {name}; check repository access and branch')
        return result.stdout.strip()
    if not (target/'.git').exists():
        if target.exists(): raise ValueError('Repository destination already contains other files')
        pending=root/(name+'.clone-pending')
        if pending.exists():shutil.rmtree(pending)
        git(['clone','--filter=blob:none','--branch',branch,'https://github.com/'+repository+'.git',str(pending)])
        pending.replace(target)
    else:
        if git(['-C',str(target),'status','--porcelain']):
            raise ValueError('NAS source checkout has local changes: '+name)
        expected='https://github.com/'+repository+'.git'
        if git(['-C',str(target),'remote','get-url','origin'])!=expected:
            raise ValueError('NAS source repository differs from configuration: '+name)
        git(['-C',str(target),'fetch','origin',branch])
        git(['-C',str(target),'checkout','--detach','FETCH_HEAD'])
    return target,git(['-C',str(target),'rev-parse','HEAD'])


def seed_images(web):
    # Explicitly selected public artwork only; no generated data or local auth.
    source=ROOT/'public/images'
    if source.exists(): shutil.copytree(source,web/'images',dirs_exist_ok=True)
    portraits=load(ROOT/'deploy/nas/character-portraits.json')
    save(web/'data/character-portraits.json',portraits)
    for record in portraits.values():
        for image in record['images']:
            path=web/image['url'].lstrip('/')
            if path.exists(): continue
            url=image['source']
            if not url.startswith('https://idolypride.jp/'):
                raise ValueError('Unexpected portrait source')
            content=download_bytes(url,'Official portrait '+path.name)
            if hashlib.sha256(content).hexdigest()!=image['sha256']:
                raise ValueError('Official portrait changed; review its source mapping before publication')
            path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(content)


def link_file(source,dest):
    dest.parent.mkdir(parents=True,exist_ok=True)
    if dest.exists():dest.unlink()
    try:os.link(source,dest)
    except OSError:shutil.copyfile(source,dest)


def materialize_snapshot(root,stage,manifest,workers):
    from PIL import Image
    web=stage/'web';plan=load(web/'data/media-plan.json')
    assets={item['name']:item for item in manifest['assetBundleList'] if item.get('state')!=4}
    catalog=load(web/'data/catalog.json')
    ui_assets=load(ROOT/'deploy/nas/image-assets.json')
    for char in catalog['characters']:
        ui_assets[f'images/characters/chibi/{char["id"]}.png']='img_chr_icon_'+char['id']
        portrait=next((name for name in ('img_chr_adv_'+char['id']+'-00','img_message_icon_'+char['id']) if name in assets),None)
        if portrait:
            ui_assets[f'images/characters/{char["id"]}.png']=portrait
            char['image']='/images/characters/'+char['id']+'.png'
    for path,name in ui_assets.items():
        if name in assets:
            plan['assets'][name]=assets[name]
            if name not in plan['images']:plan['images'].append(name)
        elif not (web/path).is_file():
            raise ValueError('No source for UI artwork: '+path)
    # One job per bank: media.materialize writes all referenced AudioClips at once.
    voices={}
    for name,bank in plan['voices'].items():voices.setdefault(bank,[]).append(name)
    jobs=[('image',name,[name]) for name in plan['images']]
    jobs += [('voice',names[0],names) for names in voices.values()]
    jobs += [('video',name,[name]) for name in plan['videos']]
    with Progress('Website media download/extract',len(jobs),mode='download') as progress:
        def process(job):
            kind,name,names=job
            try:
                extension={'image':'.webp','voice':'.flac','video':'.mp4'}[kind]
                bank=plan['voices'][name] if kind=='voice' else plan['videos'][name] if kind=='video' else name
                cached=root/'cache/media'/plan['assets'][bank]['md5']
                reused=all((cached/(item+extension)).is_file() for item in names)
                if kind=='voice':
                    name=next((item for item in names if not (cached/(item+extension)).is_file()),name)
                first=materialize(kind,name,plan=plan,cache_root=root/'cache/media',voice_names=names if kind=='voice' else None,on_download=progress.transfer)
                for item in names:
                    file=first.parent/(item+extension)
                    if not file.is_file(): raise ValueError('Referenced media was not decoded: '+item)
                    link_file(file,stage/'media'/kind/file.name)
                progress.finish('cached' if reused else 'completed')
            except Exception:progress.finish('failed');raise
        with ThreadPoolExecutor(max_workers=workers) as pool:list(pool.map(process,jobs))
    for relative,name in ui_assets.items():
        file=stage/'media/image'/(name+'.webp')
        if not file.exists():continue
        target=web/relative;target.parent.mkdir(parents=True,exist_ok=True)
        with Image.open(file) as image:image.save(target,'PNG')
    save(web/'data/catalog.json',catalog)
    # Internal CDN names/URLs remain on NAS, not in the public web snapshot.
    save(stage/'media-plan.json',plan)
    (web/'data/media-plan.json').unlink()


def add_music_snapshot(stage,master,translations,manifest):
    translated=translations/'master/zh-Hans/Music.json'
    catalog,music=music_index(manifest,load(master/'Music.json'),load(translated) if translated.exists() else {})
    if not catalog['tracks']:
        raise ValueError('No matched game music; check Music.json and Octo manifest')
    web=stage/'web'
    plan=load(web/'data/media-plan.json')
    plan['assets'].update(music['assets'])
    plan['voices'].update(music['voices'])
    plan['images']=sorted(set(plan['images'])|set(music['images']))
    save(web/'data/media-plan.json',plan)
    save(web/'data/music.json',catalog)
    print(f"NAS: indexed {len(catalog['tracks'])} songs with game jackets; audio uses verified FLAC 8",flush=True)


def build_snapshot(root,stage,master,toolkit,source,translations,manifest,workers=2,with_media=True):
    web=stage/'web';web.mkdir(parents=True,exist_ok=True)
    seed_images(web)
    subprocess.run([sys.executable,str(ROOT/'scripts/build-idoly-data.py'),
        '--master',str(master),'--toolkit',str(toolkit),'--source',str(source),
        '--translations',str(translations),'--output',str(web/'data'),
        '--report',str(stage/'data-validation.json')],check=True)
    if load(stage/'data-validation.json')['warnings']:
        raise ValueError('Translated script validation failed; inspect this release data-validation.json before publication')
    build(master,toolkit,source,translations,web/'data',report=stage/'index-report.json',history_cache=None)
    add_music_snapshot(stage,master,translations,manifest)
    if with_media:materialize_snapshot(root,stage,manifest,workers)
    catalog=load(web/'data/catalog.json')
    for story in catalog['stories']:
        relative=Path(story['path'])
        original=source/'CSV'/relative
        def signature(path):
            with path.open(encoding='utf-8-sig',newline='') as stream:
                rows=list(csv.DictReader(stream))
            return [(r['id'],r['name'],r['text']) for r in rows if r['id']!='译者']
        selected,label=original,'原文'
        source_signature=signature(original)
        for layer,title in [('reviewed','人工校对稿'),('human','人工翻译稿'),('ai','AI 初译 · 待翻译')]:
            candidate=translations/'story'/layer/relative
            if candidate.is_file() and signature(candidate)==source_signature:
                selected,label=candidate,title;break
        link_file(selected,stage/'story'/relative)
        chapter_path=web/'catalog/chapters'/(story['id']+'.json')
        chapter=load(chapter_path);chapter['label']=label;save(chapter_path,chapter)
        link_file(source/'Resource'/(story['id']+'.txt'),stage/'adv'/(story['id']+'.txt'))
    manifest_json=load(web/'catalog/manifest.json')
    manifest_json['base_path']='/catalog/releases/'+stage.name
    save(web/'catalog/manifest.json',manifest_json)
    save(stage/'resource-manifest.json',manifest)
    return catalog


def fingerprint(inputs):
    recipe=hashlib.sha256()
    for folder in ('idoly_story_index','vendor/hoshimi','deploy/nas'):
        for path in sorted((ROOT/folder).rglob('*')):
            if path.is_file() and path.suffix in ('.py','.json') and '.local.' not in path.name:
                recipe.update(path.relative_to(ROOT).as_posix().encode());recipe.update(path.read_bytes())
    recipe.update((ROOT/'scripts/build-idoly-data.py').read_bytes())
    # Intentional fixed UI artwork updates also trigger a release.
    for path in sorted((ROOT/'public/images').rglob('*')):
        if path.is_file():recipe.update(path.relative_to(ROOT).as_posix().encode());recipe.update(path.read_bytes())
    return hashlib.sha256(json.dumps([inputs,recipe.hexdigest()],sort_keys=True).encode()).hexdigest()


def run_once(root,env=os.environ,prepare_only=False):
    root.mkdir(parents=True,exist_ok=True)
    token=env.get('IDOLY_GITHUB_TOKEN','')
    s3,bucket,prefix=connect(env) if not prepare_only else (None,None,None)
    remote,etag=read_current(s3,bucket,prefix) if s3 else (None,None)
    previous=root/'releases'/remote['release'] if remote else None
    if previous and not (previous/'complete.json').is_file():
        raise ValueError('Remote release exists but NAS baseline is missing; restore its runtime volume or use a fresh R2 prefix')
    print('NAS: syncing text repositories',flush=True)
    source,source_commit=sync_repo(root/'repos','source',env.get('IDOLY_SOURCE_REPO','DreamGallery/Hoshimi-Adv'),env.get('IDOLY_SOURCE_BRANCH','main'),token)
    translations,translation_commit=sync_repo(root/'repos','translations',env.get('IDOLY_TRANSLATION_REPO','DreamGallery/Idoly-localify-translations'),env.get('IDOLY_TRANSLATION_BRANCH','main'),token)
    print('NAS: checking GitHub MasterDB snapshot',flush=True)
    master,master_info=fetch_master(root/'master',env.get('IDOLY_MASTER_REPO','MalitsPlus/ipr-master-diff'),token,env.get('IDOLY_MASTER_REF','main'))
    toolkit=root/'toolkit';(toolkit/'src').mkdir(parents=True,exist_ok=True)
    shutil.copyfile(ROOT/'vendor/hoshimi/src/adv_csv.py',toolkit/'src/adv_csv.py')
    print('NAS: checking Octo resource manifest',flush=True)
    manifest=update_manifest(toolkit/'cache/OctoManifest.json',env)
    inputs={'source':source_commit,'translations':translation_commit,'master':master_info,'octo':digest(toolkit/'cache/OctoManifest.json')}
    identity=fingerprint(inputs)
    if previous and load(previous/'complete.json')['fingerprint']==identity:
        print('NAS: inputs unchanged; retaining current release',flush=True)
        return
    release=f'idoly-r{manifest["revision"]}-{identity[:16]}'
    stage=root/'releases'/release
    workers=max(1,min(8,int(env.get('IDOLY_DOWNLOAD_WORKERS','2'))))
    if not (stage/'complete.json').exists():
        if stage.exists():shutil.rmtree(stage)
        stage.mkdir(parents=True)
        print('NAS: generating index and materializing referenced website media',flush=True)
        build_snapshot(root,stage,master,toolkit,source,translations,manifest,workers)
        print('NAS: preparing full-game increment',flush=True)
        versions=prepare_archives(root,stage,manifest,previous,workers)
        save(stage/'complete.json',{'fingerprint':identity,'inputs':inputs,'base_release':remote['release'] if remote else None})
    else:
        if load(stage/'complete.json').get('base_release')!=(remote['release'] if remote else None):
            raise ValueError('Prepared release baseline no longer matches remote current')
        versions=load(stage/'resource-versions.json')
    if prepare_only:
        print('NAS: complete local snapshot prepared; no R2 upload: '+release,flush=True);return
    publish(s3,bucket,prefix,stage,versions,etag,root/'downloads',max(1,min(8,int(env.get('IDOLY_UPLOAD_WORKERS','4')))))
    save(root/'last-success.json',{'release':release,'fingerprint':identity,'at':int(time.time())})
    # Delete only archives previously recorded by this updater, after publication.
    retained={v['filename'] for v in versions['versions']}
    for old in (remote or {}).get('versions',{}).get('versions',[]):
        name=old.get('filename','')
        if name in retained or not re.fullmatch(r'idoly-resources-r\d+-[a-f0-9]{12}\.tar\.gz',name):continue
        try:
            s3.delete_object(Bucket=bucket,Key=prefix+'/downloads/'+name)
            (root/'downloads'/name).unlink(missing_ok=True)
        except Exception:print('NAS: old archive cleanup deferred',flush=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path(os.getenv('IDOLY_RUNTIME_ROOT','/runtime')))
    parser.add_argument('--once',action='store_true')
    parser.add_argument('--prepare-only',action='store_true',help='One local preparation run; never upload or advance the published baseline')
    args=parser.parse_args();args.root.mkdir(parents=True,exist_ok=True)
    interval=max(60,int(os.getenv('IDOLY_UPDATE_INTERVAL','21600')))
    with (args.root/'update.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        while True:
            print('NAS: update started '+time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),flush=True)
            try:run_once(args.root,prepare_only=args.prepare_only);delay=interval
            except Exception as error:
                # Exception types/messages from our checks are safe. SDK request
                # dumps and signed URLs must not enter persistent Docker logs.
                message=str(error) if isinstance(error,(ValueError,RuntimeError)) else type(error).__name__
                if hasattr(error,'response') and isinstance(error.response,dict):
                    message+=' '+str(error.response.get('Error',{}).get('Code',''))
                print('NAS: update failed; published snapshot unchanged: '+message,flush=True)
                if args.once or args.prepare_only:raise SystemExit(1)
                delay=min(interval,900)
            if args.once or args.prepare_only:return
            print(f'NAS: next check in {delay} seconds',flush=True);time.sleep(delay)


if __name__=='__main__':main()
