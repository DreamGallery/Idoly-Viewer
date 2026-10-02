#!/bin/sh
set -eu
image=${1:?Usage: check_updater_image.sh IMAGE [PLATFORM]}
platform=${2:-linux/amd64}
docker run --rm -i --platform "$platform" --entrypoint python "$image" - <<'CHECK'
import importlib, pathlib, subprocess
for name in ['requests','UnityPy','PIL','Crypto.Cipher.AES','google.protobuf','boto3','idoly_story_index.runtime','idoly_story_index.publish','idoly_story_index.game_archive','idoly_story_index.master_source','idoly_story_index.music_index','idoly_story_index.textures']:
    importlib.import_module(name)
importlib.import_module('fmod_toolkit')
subprocess.run(['flac','--version'],check=True)
assert pathlib.Path('/app/scripts/build-idoly-data.py').is_file()
assert not list(pathlib.Path('/app').glob('.env*')), 'Unexpected environment file in image'
assert not pathlib.Path('/app/data').exists(), 'Downloaded assets must not be bundled'
assert not list(pathlib.Path('/app').rglob('config.ini')), 'Unexpected private toolkit config'
assert not pathlib.Path('/app/.local').exists(), 'Unexpected local cache'
assert importlib.util.find_spec('idoly_story_index.voice_migration') is None, 'Retired WAV migration module found in image'
help_text=subprocess.run(['python','-m','idoly_story_index.runtime','--help'],check=True,text=True,stdout=subprocess.PIPE).stdout
assert '--cleanup-wav' not in help_text, 'Retired WAV cleanup command found in image'
print('Updater image checks passed: dependencies, Unity/FMOD decoder, entrypoint, resource/secret exclusion, migration removal')
CHECK
