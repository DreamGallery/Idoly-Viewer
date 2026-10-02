"""Pinned MasterDB from ipr-master-diff, following its README's artifact workflow."""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import zipfile

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

TABLES = ('Character', 'CharacterGroup', 'Story', 'StoryPart', 'EventStory',
          'ExtraStory', 'LoveStoryEpisode', 'Card', 'CardEvolution', 'Skill', 'Music')
REPO_PATTERN = re.compile(r'^[\w.-]+/[\w.-]+$')


def github_session(token=''):
    session = requests.Session()
    session.headers.update({'User-Agent': 'Idoly-Viewer-NAS', 'Accept': 'application/vnd.github+json',
                            'X-GitHub-Api-Version': '2022-11-28'})
    if token:
        session.headers['Authorization'] = 'Bearer ' + token
    session.mount('https://', HTTPAdapter(max_retries=Retry(total=3, backoff_factor=1,
        status_forcelist=(429, 500, 502, 503, 504), allowed_methods=('GET', 'HEAD'))))
    return session


def api_get(session, path):
    result = session.get('https://api.github.com' + path, timeout=(15, 90))
    if not result.ok:
        # Never log response bodies or signed download URLs.
        raise RuntimeError(f'GitHub API request failed (HTTP {result.status_code})')
    return result.json()


def unpack_table(name, data):
    if name.endswith('.gz'):
        data = gzip.decompress(data)
    elif name.endswith('.zip'):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            items = [i for i in archive.infolist() if i.filename.endswith('.json') and not i.is_dir()]
            if len(items) != 1 or items[0].file_size > 512 * 1024 * 1024:
                raise ValueError('Invalid compressed MasterDB table')
            data = archive.read(items[0])
    value = json.loads(data)
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise ValueError('MasterDB table must be an array of records')
    return data


def artifact_tables(data):
    """Read known basenames only; no ZIP member is extracted to its own path."""
    result = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for info in archive.infolist():
            name = Path(info.filename).name
            table = next((n for n in TABLES if name in (n+'.json', n+'.json.gz', n+'.json.zip')), None)
            if not table:
                continue
            if table in result or info.file_size > 512 * 1024 * 1024:
                raise ValueError('Duplicate or oversized MasterDB table')
            result[table] = unpack_table(name, archive.read(info))
        versions = [i for i in archive.infolist() if Path(i.filename).name == '!version.txt']
        if len(versions) != 1:
            raise ValueError('MasterDB artifact has no unique version')
        version = archive.read(versions[0]).decode().strip()
    if set(result) != set(TABLES):
        raise ValueError('MasterDB artifact is incomplete for this index')
    return result, version


def fetch_master(root, repo='MalitsPlus/ipr-master-diff', token='', ref='main'):
    if not REPO_PATTERN.fullmatch(repo):
        raise ValueError('Invalid MasterDB repository')
    session = github_session(token)
    commit = api_get(session, f'/repos/{repo}/commits/{requests.utils.quote(ref, safe="")}')['sha']
    if not re.fullmatch('[a-f0-9]{40}', commit):
        raise ValueError('Invalid MasterDB commit')
    destination = root / commit
    stamp = destination / 'snapshot.json'
    if stamp.exists():
        state = json.loads(stamp.read_text())
        if all((destination / (n+'.json')).is_file() and
               hashlib.sha256((destination / (n+'.json')).read_bytes()).hexdigest() == state['tables'].get(n)
               for n in TABLES):
            return destination, state
    tree = api_get(session, f'/repos/{repo}/git/trees/{commit}')
    entries = {row['path']: row for row in tree['tree'] if row['type'] == 'blob'}
    version_info = entries['!version.txt']

    def blob(name):
        info = entries[name]
        # Public, pinned raw files; no GitHub token forwarded to raw/CDN hosts.
        r = requests.get(f'https://raw.githubusercontent.com/{repo}/{commit}/{requests.utils.quote(name)}', timeout=(15, 90))
        if not r.ok:
            raise RuntimeError(f'MasterDB table download failed (HTTP {r.status_code})')
        data = r.content
        if hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest() != info['sha']:
            raise ValueError('MasterDB Git blob checksum mismatch')
        return data

    version = blob('!version.txt').decode().strip()
    tables, origin = None, 'pinned-repository-tables'
    # README names this artifact "databases". Artifacts require Actions:read even
    # for public repositories. Use only an unexpired artifact for this exact HEAD.
    if token:
        listing=session.get(f'https://api.github.com/repos/{repo}/actions/artifacts?name=databases&per_page=100',timeout=(15,90))
        if listing.status_code in (403,404):
            artifacts=[]
        elif listing.ok:
            artifacts=listing.json()['artifacts']
        else:
            raise RuntimeError(f'MasterDB artifact listing failed (HTTP {listing.status_code})')
        candidates = [a for a in artifacts if not a['expired'] and a.get('workflow_run', {}).get('head_sha') == commit]
        if candidates:
            artifact = max(candidates, key=lambda a: a['created_at'])
            response = session.get(f'https://api.github.com/repos/{repo}/actions/artifacts/{artifact["id"]}/zip',
                                   allow_redirects=False, timeout=(15, 90))
            if response.status_code == 302:
                url = response.headers['Location']
                if not url.startswith('https://'):
                    raise ValueError('Invalid artifact download redirect')
                downloaded = requests.get(url, timeout=(15, 300))
                if downloaded.status_code != 200:
                    raise RuntimeError('MasterDB artifact download failed')
                tables, artifact_version = artifact_tables(downloaded.content)
                if artifact_version != version:
                    raise ValueError('Artifact version differs from pinned repository')
                origin = 'actions-artifact'
            elif response.status_code not in (403, 404, 410):
                raise RuntimeError(f'MasterDB artifact request failed (HTTP {response.status_code})')
    if tables is None:
        print('MasterDB: no usable matching Actions artifact; reading pinned repository tables.', flush=True)
        tables = {}
        for table in TABLES:
            name = next((n for n in (table+'.json', table+'.json.gz', table+'.json.zip') if n in entries), None)
            if not name:
                raise ValueError('Missing MasterDB table: '+table)
            tables[table] = unpack_table(name, blob(name))
    temporary = root / (commit+'.pending')
    temporary.mkdir(parents=True, exist_ok=True)
    for name, data in tables.items():
        (temporary / (name+'.json')).write_bytes(data)
    (temporary / '!version.txt').write_text(version)
    state = {'repository': repo, 'commit': commit, 'version': version, 'origin': origin,
             'tables': {n: hashlib.sha256(data).hexdigest() for n, data in tables.items()}}
    (temporary / 'snapshot.json').write_text(json.dumps(state))
    # A prior broken cache is repaired file by file; callers only use a verified stamp.
    destination.mkdir(parents=True, exist_ok=True)
    for path in temporary.iterdir():
        os.replace(path, destination/path.name)
    temporary.rmdir()
    return destination, state
