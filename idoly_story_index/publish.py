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
from urllib.parse import quote, urlsplit

from .build import save
from .public_text import original_csv, original_story
from .r2_inventory import inventory_for, verification_prefixes


def public_media_base(value):
    value = value.strip().rstrip('/')
    if not value:
        return ''
    try:
        url = urlsplit(value)
        valid = (url.scheme == 'https' and url.hostname and url.username is None and url.password is None
                 and value == 'https://' + url.netloc)
        url.port  # Reject malformed ports before syncing or uploading anything.
    except ValueError:
        valid = False
    if not valid or any(c.isspace() or ord(c) < 32 for c in value) or '\\' in value:
        raise ValueError('IDOLY_R2_PUBLIC_BASE_URL must be an HTTPS origin without a path, credentials, query or fragment')
    return value


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
        raise ValueError('Fill R2 endpoint, bucket and access credentials in the updater environment file')
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


def snapshot_plan(stage, *, public_base='', prefix='idoly-v1'):
    public_base = public_media_base(public_base)
    if not re.fullmatch(r'[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*', prefix):
        raise ValueError('Invalid public resource prefix')
    files, jobs = {}, {}
    paths, media_urls = [], {}
    scanned=0;last_log=time.monotonic()
    def progress():
        nonlocal scanned, last_log
        scanned+=1
        if time.monotonic()-last_log>=10:
            print(f'R2: prepared {scanned} snapshot files',flush=True);last_log=time.monotonic()
    for folder in ('web','story','adv','media'):
        for path in sorted((stage/folder).rglob('*')):
            if path.is_symlink():
                raise ValueError('Snapshot may not contain symbolic links')
            if not path.is_file(): continue
            relative = path.relative_to(stage).as_posix()
            if '\\' in relative or any(ord(c)<32 for c in relative):
                raise ValueError('Invalid snapshot filename')
            category = 'media' if folder=='media' or relative.startswith('web/images/') else 'text'
            paths.append((path, relative, category))
    # Media hashes do not depend on the index. Resolve them before serializing
    # JSON, so direct URLs and their enclosing text hashes stay immutable.
    for path, relative, category in paths:
        if category == 'media':
            sha = digest(path)
            key = f'{category}/{sha}/{path.name}'
            files[relative] = key
            jobs[key] = (path,sha)
            logical_url = '/' + relative.removeprefix('web/') if relative.startswith('web/') else '/api/' + relative
            media_urls[logical_url] = (public_base + '/' + prefix if public_base else '') + '/' + quote(key, safe='/')
            progress()

    def rewrite(value):
        if isinstance(value, list):
            return [rewrite(item) for item in value]
        if isinstance(value, dict):
            return {key: rewrite(item) for key, item in value.items()}
        return media_urls.get(value, value) if isinstance(value, str) else value

    for path, relative, category in paths:
        if category == 'media':
            continue
        body = None
        if relative.startswith('story/'):
            if path.suffix != '.csv':
                raise ValueError('Only original CSV belongs in the public story directory')
            body = original_csv(path.read_bytes().decode('utf-8-sig')).encode()
        elif relative.startswith('web/') and path.suffix == '.json':
            value = json.loads(path.read_bytes())
            if relative.startswith('web/data/stories/'):
                value = original_story(value)
            if relative.startswith('web/catalog/') and '/chapters/' in relative:
                value['label'] = '原文'
            body = json.dumps(rewrite(value), ensure_ascii=False, separators=(',', ':')).encode()
        if body is not None:
            # Never rewrite an input file: snapshots may share hard links with
            # the extraction cache or a retained release.
            path = stage/'public-export'/relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        sha = hashlib.sha256(body).hexdigest() if body is not None else digest(path)
        key = f'text/{sha}/{path.name}'
        files[relative] = key
        jobs[key] = (path, sha)
        progress()
    # More than 100k voice clips: a flat map can exhaust a small Worker isolate.
    shards={}
    for logical,key in files.items():
        shard=hashlib.sha256(logical.encode()).hexdigest()[:2]
        shards.setdefault(shard,{})[logical]=key
    for shard,entries in shards.items():save(stage/'maps'/(shard+'.json'),{'files':entries})
    save(stage/'file-map.json', {'schema_version':1,'text_policy':'original-only','files':{},'shards':{
        shard:f'releases/{stage.name}/maps/{shard}.json' for shard in sorted(shards)}})
    return files,jobs


def upload_batch(s3,bucket,prefix,jobs,label,workers=4,inventory=None):
    # Only ListObjectsV2 pagination; never one HEAD request per file. Hash keys
    # are immutable and owned by this publisher; size detects truncated objects.
    if not jobs:return
    existing=inventory if inventory is not None else inventory_for(s3,bucket,prefix,jobs,workers=workers)
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
                elif path.suffix=='.mp3':mime='audio/mpeg'
                elif path.suffix=='.m4a':mime='audio/mp4'
                elif path.suffix=='.csv':mime='text/csv; charset=utf-8'
                elif path.suffix=='.json':mime='application/json; charset=utf-8'
                elif path.suffix=='.txt':mime='text/plain; charset=utf-8'
                elif path.name.endswith('.tar.gz'):mime='application/gzip'
                cache_control='no-store' if key.startswith('downloads/') else 'public, max-age=31536000, immutable'
                s3.upload_file(str(path),bucket,prefix+'/'+key,ExtraArgs={'ContentType':mime,
                    'CacheControl':cache_control,'Metadata':{'sha256':sha}},Callback=progress.transfer)
                uploaded.append(key);progress.finish('uploaded')
            except Exception:progress.finish('failed');raise
        with ThreadPoolExecutor(max_workers=workers) as pool:list(pool.map(upload,jobs.items()))
    if uploaded:
        pending={key:jobs[key] for key in uploaded}
        checked=inventory_for(s3,bucket,prefix,pending,workers=workers,
            prefixes=verification_prefixes(pending,existing),phase='verification')
        for key in uploaded:
            if checked.get(key)!=jobs[key][0].stat().st_size:raise ValueError('R2 upload size verification failed: '+key)


def publish(s3,bucket,prefix,stage,versions,expected_etag,download_root,workers=4,*,public_base=''):
    release=stage.name
    if not re.fullmatch('[A-Za-z0-9_-]+',release): raise ValueError('Invalid release ID')
    print('R2: hashing local snapshot before upload',flush=True)
    _,jobs=snapshot_plan(stage,public_base=public_base,prefix=prefix)
    print('R2: original-only text; media '+('uses the configured public origin' if public_base else 'uses same-origin content hashes'),flush=True)
    upload_batch(s3,bucket,prefix,jobs,'R2: resources and text',workers)
    archives={}
    for item in versions['versions']:
        name=item['filename']
        if not re.fullmatch(r'idoly-resources-r\d+-[a-f0-9]{12}\.tar\.gz',name): raise ValueError('Invalid archive name')
        path=download_root/name
        if digest(path)!=item['sha256'] or path.stat().st_size!=item['bytes']: raise ValueError('Archive checksum mismatch')
        archives['downloads/'+name]=(path,item['sha256'])
    upload_batch(s3,bucket,prefix,archives,'R2: incremental archives',min(workers,2))
    maps={f'releases/{release}/maps/{path.name}':(path,digest(path)) for path in (stage/'maps').glob('*.json')}
    upload_batch(s3,bucket,prefix,maps,'R2: map shards',workers)
    mapping=stage/'file-map.json'
    upload_batch(s3,bucket,prefix,{f'releases/{release}/file-map.json':(mapping,digest(mapping))},'R2: release map',1)
    pointer={'schema_version':1,'text_policy':'original-only','release':release,'published_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'versions':versions}
    # Compare-and-swap also protects first publication against another updater.
    condition={'IfMatch':expected_etag} if expected_etag else {'IfNoneMatch':'*'}
    print('R2: all objects verified; switching current.json',flush=True)
    s3.put_object(Bucket=bucket,Key=prefix+'/current.json',Body=json.dumps(pointer).encode(),
                  ContentType='application/json',CacheControl='no-store',**condition)
    print('R2: publication complete '+release,flush=True)
    return pointer
