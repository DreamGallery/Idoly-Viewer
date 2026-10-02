"""Content-addressed R2 publication, with progress and an atomic final pointer."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import threading
import time

from .build import save


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            result.update(chunk)
    return result.hexdigest()


def connect(env=os.environ):
    import boto3
    from botocore.config import Config
    required = ['IDOLY_R2_ENDPOINT','IDOLY_R2_BUCKET','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY']
    if any(not env.get(k) for k in required):
        raise ValueError('Fill R2 endpoint, bucket and access credentials in the NAS environment file')
    endpoint = env['IDOLY_R2_ENDPOINT']
    if not endpoint.startswith('https://'):
        raise ValueError('R2 endpoint must use HTTPS')
    prefix = env.get('IDOLY_R2_PREFIX','idoly-v1')
    if not re.fullmatch(r'[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*',prefix):
        raise ValueError('R2 requires a dedicated, safe prefix')
    client = boto3.client('s3', endpoint_url=endpoint, region_name='auto',
        aws_access_key_id=env['AWS_ACCESS_KEY_ID'], aws_secret_access_key=env['AWS_SECRET_ACCESS_KEY'],
        config=Config(retries={'max_attempts':5,'mode':'standard'},
                      request_checksum_calculation='when_required',response_checksum_validation='when_required'))
    return client, env['IDOLY_R2_BUCKET'], prefix


def read_current(s3, bucket, prefix):
    from botocore.exceptions import ClientError
    try:
        response = s3.get_object(Bucket=bucket, Key=prefix+'/current.json')
    except ClientError as error:
        if error.response['Error']['Code'] in ('NoSuchKey','404'):
            return None, None
        raise
    value = json.loads(response['Body'].read())
    if not re.fullmatch('[A-Za-z0-9_-]+', value.get('release','')):
        raise ValueError('Invalid remote publication pointer')
    return value, response['ETag']


class Progress:
    """Heartbeat stays alive during large uploads, retries, and remote checks."""
    def __init__(self, label, total, *, mode='upload'):
        self.label, self.total = label, total
        self.mode = mode
        self.done = self.uploaded = self.skipped = self.failed = self.bytes = 0
        self.completed = self.cached = 0
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.started = time.monotonic()
    def transfer(self, amount):
        with self.lock: self.bytes += amount
    def finish(self, status):
        with self.lock:
            self.done += 1
            setattr(self, status, getattr(self,status)+1)
    def log(self):
        with self.lock:
            counts = (f'completed={self.completed} cached={self.cached}' if self.mode=='download'
                      else f'uploaded={self.uploaded} skipped={self.skipped}')
            direction = 'downloaded' if self.mode=='download' else 'uploaded'
            print(f'{self.label}: {self.done}/{self.total} | {counts} failed={self.failed} | '
                  f'{direction}={self.bytes/1048576:.2f} MiB | {time.monotonic()-self.started:.0f}s', flush=True)
    def __enter__(self):
        def loop():
            while not self.stop.wait(10): self.log()
        self.thread = threading.Thread(target=loop,daemon=True); self.thread.start(); self.log()
        return self
    def __exit__(self, *args):
        self.stop.set(); self.thread.join(); self.log()


def snapshot_plan(stage):
    files, jobs = {}, {}
    scanned=0;last_log=time.monotonic()
    for folder in ('web','story','adv','media'):
        for path in sorted((stage/folder).rglob('*')):
            if path.is_symlink():
                raise ValueError('Snapshot may not contain symbolic links')
            if not path.is_file(): continue
            relative = path.relative_to(stage).as_posix()
            if '\\' in relative or any(ord(c)<32 for c in relative):
                raise ValueError('Invalid snapshot filename')
            sha = digest(path)
            scanned+=1
            if time.monotonic()-last_log>=10:
                print(f'R2: hashed {scanned} snapshot files',flush=True);last_log=time.monotonic()
            category = 'media' if folder=='media' or relative.startswith('web/images/') else 'text'
            key = f'{category}/{sha}/{path.name}'
            files[relative] = key
            jobs[key] = (path,sha)
    # More than 100k voice clips: a flat map can exhaust a small Worker isolate.
    shards={}
    for logical,key in files.items():
        shard=hashlib.sha256(logical.encode()).hexdigest()[:2]
        shards.setdefault(shard,{})[logical]=key
    for shard,entries in shards.items():save(stage/'maps'/(shard+'.json'),{'files':entries})
    save(stage/'file-map.json', {'schema_version':1,'files':{},'shards':{
        shard:f'releases/{stage.name}/maps/{shard}.json' for shard in sorted(shards)}})
    return files,jobs


def inventory_for(s3,bucket,prefix,jobs):
    roots=set()
    for key in jobs:
        parts=key.split('/')
        roots.add('/'.join(parts[:2]) if parts[0]=='releases' else parts[0])
    inventory={}
    for folder in sorted(roots):
        print('R2: batch listing '+folder,flush=True)
        count=0
        for page in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket,Prefix=prefix+'/'+folder+'/'):
            for item in page.get('Contents',[]):inventory[item['Key'][len(prefix)+1:]]=item['Size']
            count+=len(page.get('Contents',[]))
            if count and count%10000==0:print(f'R2: scanned {count} {folder} objects',flush=True)
    return inventory


def upload_batch(s3,bucket,prefix,jobs,label,workers=4,inventory=None):
    # Only ListObjectsV2 pagination; never one HEAD request per file. Hash keys
    # are immutable and owned by this publisher; size detects truncated objects.
    if not jobs:return
    existing=inventory if inventory is not None else inventory_for(s3,bucket,prefix,jobs)
    uploaded=[]
    with Progress(label,len(jobs)) as progress:
        def upload(job):
            key,(path,sha)=job
            try:
                if key in existing:
                    if existing[key]!=path.stat().st_size:raise ValueError('R2 immutable object size conflict: '+key)
                    progress.finish('skipped');return
                mime=mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
                if path.suffix=='.flac':mime='audio/flac'
                elif path.suffix=='.csv':mime='text/csv; charset=utf-8'
                elif path.suffix=='.json':mime='application/json; charset=utf-8'
                elif path.suffix=='.txt':mime='text/plain; charset=utf-8'
                elif path.name.endswith('.tar.gz'):mime='application/gzip'
                s3.upload_file(str(path),bucket,prefix+'/'+key,ExtraArgs={'ContentType':mime,
                    'CacheControl':'public, max-age=31536000, immutable','Metadata':{'sha256':sha}},Callback=progress.transfer)
                uploaded.append(key);progress.finish('uploaded')
            except Exception:progress.finish('failed');raise
        with ThreadPoolExecutor(max_workers=workers) as pool:list(pool.map(upload,jobs.items()))
    if uploaded:
        print('R2: batch verification after upload',flush=True)
        checked=inventory_for(s3,bucket,prefix,{key:jobs[key] for key in uploaded})
        for key in uploaded:
            if checked.get(key)!=jobs[key][0].stat().st_size:raise ValueError('R2 upload size verification failed: '+key)


def publish(s3,bucket,prefix,stage,versions,expected_etag,download_root,workers=4):
    release=stage.name
    if not re.fullmatch('[A-Za-z0-9_-]+',release): raise ValueError('Invalid release ID')
    print('R2: hashing local snapshot before upload',flush=True)
    _,jobs=snapshot_plan(stage)
    inventory={}
    for folder in ('media','text'):
        print('R2: listing existing '+folder+' objects',flush=True)
        for page in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket,Prefix=prefix+'/'+folder+'/'):
            for item in page.get('Contents',[]):inventory[item['Key'][len(prefix)+1:]]=item['Size']
    upload_batch(s3,bucket,prefix,jobs,'R2 resources and text',workers,inventory)
    archives={}
    for item in versions['versions']:
        name=item['filename']
        if not re.fullmatch(r'idoly-resources-r\d+-[a-f0-9]{12}\.tar\.gz',name): raise ValueError('Invalid archive name')
        path=download_root/name
        if digest(path)!=item['sha256'] or path.stat().st_size!=item['bytes']: raise ValueError('Archive checksum mismatch')
        archives['downloads/'+name]=(path,item['sha256'])
    upload_batch(s3,bucket,prefix,archives,'R2 incremental archives',min(workers,2))
    maps={f'releases/{release}/maps/{path.name}':(path,digest(path)) for path in (stage/'maps').glob('*.json')}
    upload_batch(s3,bucket,prefix,maps,'R2 map shards',workers)
    mapping=stage/'file-map.json'
    upload_batch(s3,bucket,prefix,{f'releases/{release}/file-map.json':(mapping,digest(mapping))},'R2 release map',1)
    pointer={'schema_version':1,'release':release,'published_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'versions':versions}
    # Compare-and-swap also protects first publication against another NAS.
    condition={'IfMatch':expected_etag} if expected_etag else {'IfNoneMatch':'*'}
    print('R2: all objects verified; switching current.json',flush=True)
    s3.put_object(Bucket=bucket,Key=prefix+'/current.json',Body=json.dumps(pointer).encode(),
                  ContentType='application/json',CacheControl='no-store',**condition)
    print('R2: publication complete '+release,flush=True)
    return pointer
