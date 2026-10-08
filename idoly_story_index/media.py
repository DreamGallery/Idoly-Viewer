"""Resolve allowlisted game media into an atomic local cache, on demand."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import sys

from .build import ROOT, WORK, load
from .downloads import download_file
from .audio import encode_flac, encode_audio
from .voice_encoding import VoiceEncoding, encoding_for_bank
from .textures import select_texture
from .unity import load_bundle


def select_voice_clips(clips, names):
    """Prefer exact Unity names, then an explicit .wav suffix used by some banks."""
    indexed = {}
    for clip in clips:
        indexed.setdefault(clip.m_Name, []).append(clip)
    selected = {}
    for name in names:
        matches = indexed.get(name) or indexed.get(name + '.wav') or []
        if len(matches) > 1:
            raise ValueError('Ambiguous audio name in game bundle: ' + name)
        if matches:
            selected[name] = matches[0]
    return selected


def materialize(kind, name, root=ROOT, *, plan=None, cache_root=None, voice_names=None, on_download=None, voice_encoding=VoiceEncoding()):
    # No user-supplied URLs or paths: all downloads come from the indexed manifest.
    plan=plan if plan is not None else load(root/'public/data/media-plan.json')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+',name):
        raise ValueError('Invalid asset name')
    if kind=='image' and name in plan['images']:
        bank=name
    elif kind=='voice' and name in plan['voices']:
        bank=plan['voices'][name]
    elif kind=='video' and name in plan.get('videos',{}):
        bank=plan['videos'][name]
    else:
        raise ValueError('Asset is not referenced by this index')
    item=plan['assets'][bank]
    cache=(cache_root or root/'.local/media')/item['md5']
    encoding=encoding_for_bank(bank,voice_encoding)
    output_cache=encoding.cache_directory(cache) if kind=='voice' else cache
    target=output_cache/(name+('.webp' if kind=='image' else '.mp4' if kind=='video' else encoding.extension))
    if target.is_file():return target
    output_cache.mkdir(parents=True,exist_ok=True)
    bundle=cache/'source.bundle'
    if bundle.is_file():
        raw=bundle.read_bytes()
    else:
        url=plan['urlFormat']
        for k,v in {'v':item['uploadVersionId'],'type':'resources' if kind=='video' else 'assetbundle','o':item['objectName'],'g':item['generation']}.items():
            url=url.replace('{'+k+'}',str(v))
        if not url.startswith('https://') or '{' in url:raise ValueError('Invalid manifest URL')
        download_file(url,bundle,bank,size=item['size'],md5=item['md5'],on_download=on_download)
        raw=bundle.read_bytes()
    if len(raw)!=item['size'] or hashlib.md5(raw).hexdigest()!=item['md5']:
        raise ValueError('Game resource checksum mismatch')
    def atomic(path, data):
        temp=path.with_name(path.name+'.'+str(os.getpid())+'.tmp');temp.write_bytes(data);temp.replace(path)
    if kind=='video':
        if b'ftyp' not in raw[:32]:raise ValueError('Invalid MP4 resource')
        atomic(target,raw)
        return target
    if not bundle.exists():atomic(bundle,raw)
    from .octo_source import decrypt_bundle
    decoded=decrypt_bundle(raw,bank)
    env=load_bundle(decoded)
    if kind=='image':
        picture=select_texture(env,name).image
        picture.thumbnail((1600,1600))
        from io import BytesIO
        output=BytesIO();picture.save(output,format='WEBP',quality=88);atomic(target,output.getvalue())
    else:
        # Decode the whole bank once, keeping exact AudioClip names (not array order).
        allowed=set(voice_names) if voice_names is not None else {n for n,b in plan['voices'].items() if b==bank}
        clips=[obj.read() for obj in env.objects if obj.type.name=='AudioClip']
        for output_name,clip in select_voice_clips(clips,allowed).items():
            output=output_cache/(output_name+encoding.extension)
            if output.is_file():continue
            samples=clip.samples
            if len(samples)!=1:continue
            value=next(iter(samples.values()))
            if value[:4]!=b'RIFF' or value[8:12]!=b'WAVE':raise ValueError('Invalid decoded audio')
            if encoding.codec=='flac':encode_flac(value,output)
            else:encode_audio(value,output,encoding)
    if not target.is_file():raise ValueError('Exact audio/image name missing from game bundle')
    return target

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind',choices=['image','voice','video']);parser.add_argument('name')
    args=parser.parse_args()
    print(materialize(args.kind,args.name))
