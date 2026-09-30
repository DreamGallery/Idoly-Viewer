"""Full changed Octo resources plus extracted/corrected images, five revisions."""
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tarfile
import time

from .build import save
from .octo_source import decrypt_bundle
from .publish import digest, Progress
from .downloads import download_file

RECIPE=1


def safe_name(name):
    if not isinstance(name,str) or not name or name in ('.','..') or '/' in name or '\\' in name or any(ord(c)<32 for c in name):
        raise ValueError('Unsafe game resource name')
    return name


def snapshot(manifest):
    return {kind+'/'+safe_name(row['name']): {'md5':row['md5'],'size':row['size']}
            for kind in ('assetBundleList','resourceList') for row in manifest[kind] if row.get('state')!=4}


def download_raw(manifest,kind,item,cache,on_download=None):
    name=safe_name(item['name']); md5=item['md5']
    if not re.fullmatch('[a-f0-9]{32}',md5): raise ValueError('Invalid game checksum')
    path=cache/md5/'source.bundle';path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists():
        if path.stat().st_size==item['size'] and hashlib.md5(path.read_bytes()).hexdigest()==md5: return path
        path.unlink()
    url=manifest['urlFormat']
    for key,value in {'v':item['uploadVersionId'],'type':'assetbundle' if kind=='assetBundleList' else 'resources','o':item['objectName'],'g':item['generation']}.items():
        url=url.replace('{'+key+'}',str(value))
    if not url.startswith('https://') or '{' in url: raise ValueError('Invalid game resource URL')
    return download_file(url,path,name,size=item['size'],md5=md5,on_download=on_download)


def stretch_size(name):
    # Match IDOLY's toolkit rules, including the alternate awakened card face.
    if name.startswith(('img_card_full_1_','img_card_full_2_')) or (name.startswith('img_ui_hero_') and not name.startswith('img_ui_hero_event')):
        return (2560,1440)
    return None


def process_item(manifest,kind,item,cache,dest,on_download=None):
    import UnityPy
    from PIL import Image
    UnityPy.config.FALLBACK_UNITY_VERSION=os.environ.get('IDOLY_UNITY_VERSION','2022.3.57f1')
    name=safe_name(item['name'])
    raw=download_raw(manifest,kind,item,cache,on_download=on_download)
    target=dest/('assetbundle' if kind=='assetBundleList' else 'resource')/name
    target.parent.mkdir(parents=True,exist_ok=True)
    if kind=='resourceList': shutil.copyfile(raw,target); return
    decoded=decrypt_bundle(raw.read_bytes(),name);target.write_bytes(decoded)
    env=UnityPy.load(decoded)
    for obj in env.objects:
        if obj.type.name!='Texture2D': continue
        texture=obj.read();texture_name=safe_name(texture.m_Name)
        if not texture_name.startswith(('img','env')): continue
        image=texture.image
        path=dest/'image/Texture2D'/(texture_name+'.png');path.parent.mkdir(parents=True,exist_ok=True)
        image.save(path,'PNG')
        size=stretch_size(texture_name)
        if size:
            path=dest/'stretch'/(texture_name+'.png');path.parent.mkdir(parents=True,exist_ok=True)
            image.resize(size,Image.Resampling.LANCZOS).save(path,'PNG')


def portable_member(member):
    if not member.isfile() and not member.isdir(): raise ValueError('Archive only accepts regular files/directories')
    member.mode=0o755 if member.isdir() else 0o644
    member.uid=member.gid=member.mtime=0
    member.uname=member.gname=''
    member.pax_headers={k:v for k,v in member.pax_headers.items() if k in ('path','size')}
    return member


def write_archive(directory,destination):
    destination.parent.mkdir(parents=True,exist_ok=True)
    partial=destination.with_suffix('.partial')
    try:
        with partial.open('wb') as stream, gzip.GzipFile(fileobj=stream,mode='wb',mtime=0,filename='',compresslevel=1) as zipped:
            with tarfile.open(fileobj=zipped,mode='w|',format=tarfile.PAX_FORMAT) as archive:
                for file in sorted(directory.iterdir()): archive.add(file,arcname=file.name,filter=portable_member)
        partial.chmod(0o644);os.replace(partial,destination)
    finally: partial.unlink(missing_ok=True)


def prepare_archives(root,stage,manifest,previous,workers=4):
    before=json.loads((previous/'resource-snapshot.json').read_text()) if previous else None
    versions=json.loads((previous/'resource-versions.json').read_text())['versions'] if previous else []
    current=snapshot(manifest);revision=str(manifest['revision'])
    save(stage/'resource-snapshot.json',{'revision':revision,'resources':current})
    if before is None or before['resources']==current:
        result={'revision':revision,'versions':versions,'baseline_only':not versions}
        save(stage/'resource-versions.json',result);return result
    changes=[(kind,row) for kind in ('assetBundleList','resourceList') for row in manifest[kind]
             if row.get('state')!=4 and before['resources'].get(kind+'/'+row['name'])!=current[kind+'/'+row['name']]]
    removed=sorted(set(before['resources'])-set(current))
    identity=hashlib.sha256(json.dumps([RECIPE,current,before],sort_keys=True).encode()).hexdigest()
    work=root/'cache/packages'/identity; output=work/'output';output.mkdir(parents=True,exist_ok=True)
    with Progress('Game increment download/extract',len(changes),mode='download') as progress:
        def process(pair):
            kind,item=pair;path=work/'items'/kind/safe_name(item['name']);marker=path/'.complete'
            try:
                if marker.exists(): progress.finish('cached');return path
                if path.exists(): shutil.rmtree(path)
                path.mkdir(parents=True)
                process_item(manifest,kind,item,root/'cache/media',path,on_download=progress.transfer)
                marker.write_text('ok');progress.finish('completed');return path
            except Exception: progress.finish('failed');raise
        with ThreadPoolExecutor(max_workers=workers) as pool: paths=list(pool.map(process,changes))
    # Manifest order resolves texture duplicates deterministically. Retain original
    # decoded assets and full-resolution PNG alongside aspect-corrected copies.
    for path in paths:
        for file in sorted(path.rglob('*')):
            if not file.is_file() or file.name=='.complete':continue
            target=output/file.relative_to(path);target.parent.mkdir(parents=True,exist_ok=True)
            if target.exists():target.unlink()
            os.link(file,target)
    save(output/'increment.json',{'schema_version':1,'from_revision':before['revision'],'revision':revision,
        'changed':[kind+'/'+item['name'] for kind,item in changes],'removed':removed,
        'images':'image/Texture2D contains original PNG; stretch contains 2560x1440 card/hero variants'})
    filename=f'idoly-resources-r{revision}-{identity[:12]}.tar.gz';target=root/'downloads'/filename
    if not target.exists():
        print('Game increment: packing complete processed resources (files 644, directories 755)',flush=True)
        write_archive(output,target)
    entry={'revision':revision,'from_revision':before['revision'],'kind':'incremental','filename':filename,
           'url':'/api/resources/download/'+filename,'bytes':target.stat().st_size,'sha256':digest(target),'created_at':int(time.time())}
    result={'revision':revision,'versions':([entry]+[v for v in versions if v['revision']!=revision])[:5]}
    save(stage/'resource-versions.json',result)
    return result
