#!/bin/sh
set -eu
image=${1:?Usage: check_updater_image.sh IMAGE [PLATFORM]}
platform=${2:-linux/amd64}
docker run --rm -i --platform "$platform" --entrypoint python "$image" - <<'CHECK'
import importlib, pathlib, subprocess
for name in ['requests','UnityPy','PIL','Crypto.Cipher.AES','google.protobuf','boto3','idoly_story_index.runtime','idoly_story_index.publish','idoly_story_index.game_archive','idoly_story_index.master_source']:
    importlib.import_module(name)
importlib.import_module('fmod_toolkit')
assert pathlib.Path('/app/scripts/build-idoly-data.py').is_file()
assert not list(pathlib.Path('/app').glob('.env*')), 'Unexpected environment file in image'
assert not pathlib.Path('/app/data').exists(), 'Downloaded assets must not be bundled'
assert not list(pathlib.Path('/app').rglob('config.ini')), 'Unexpected private toolkit config'
assert not pathlib.Path('/app/.local').exists(), 'Unexpected local cache'
subprocess.run(['python','-m','idoly_story_index.runtime','--help'],check=True,stdout=subprocess.DEVNULL)
print('Updater image checks passed: dependencies, Unity/FMOD decoder, entrypoint, resource/secret exclusion')
CHECK
