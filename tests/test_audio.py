import hashlib
import io
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave
from idoly_story_index.audio import encode_flac
from idoly_story_index.media import materialize


class AudioCacheTests(unittest.TestCase):
    def test_decode_game_clip_ignores_legacy_wav_and_reuses_flac(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);bundle=b'game-bundle';checksum=hashlib.md5(bundle).hexdigest()
            cache=root/checksum;cache.mkdir();(cache/'source.bundle').write_bytes(bundle)
            legacy=cache/'voice.wav';legacy.write_bytes(b'obsolete local WAV')
            pcm=b'RIFF\x00\x00\x00\x00WAVEgame audio'
            clip=SimpleNamespace(m_Name='voice.wav',samples={'voice.wav':pcm})
            obj=SimpleNamespace(type=SimpleNamespace(name='AudioClip'),read=lambda:clip)
            plan={'images':[],'voices':{'voice':'bank'},'assets':{'bank':{'md5':checksum,'size':len(bundle)}}}
            def encode(value,target):
                self.assertEqual(value,pcm)
                target.write_bytes(b'fLaC-game-audio');return target
            with patch('idoly_story_index.media.download_file') as download, \
                 patch('idoly_story_index.octo_source.decrypt_bundle',return_value=b'decoded'), \
                 patch('UnityPy.load',return_value=SimpleNamespace(objects=[obj])) as decode, \
                 patch('idoly_story_index.media.encode_flac',side_effect=encode) as encoder:
                result=materialize('voice','voice',plan=plan,cache_root=root)
                self.assertEqual(result,cache/'voice.flac')
                self.assertEqual(result.read_bytes(),b'fLaC-game-audio')
                self.assertEqual(materialize('voice','voice',plan=plan,cache_root=root),result)
                encoder.assert_called_once();decode.assert_called_once();download.assert_not_called()
            self.assertEqual(legacy.read_bytes(),b'obsolete local WAV')


@unittest.skipUnless(shutil.which('flac'),'FLAC executable required; run inside updater image')
class RealFlacTests(unittest.TestCase):
    def test_level8_roundtrip_preserves_samples_and_reduces_size(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/'voice.wav';target=root/'voice.flac'
            pcm=b''.join(struct.pack('<h',(i%80-40)*200) for i in range(44100))
            with wave.open(str(source),'wb') as wav:wav.setparams((1,2,44100,0,'NONE',''));wav.writeframes(pcm)
            encode_flac(source,target)
            self.assertEqual(target.read_bytes()[:4],b'fLaC');self.assertLess(target.stat().st_size,source.stat().st_size)
            result=subprocess.run(['flac','--decode','--stdout','--silent',str(target)],check=True,stdout=subprocess.PIPE)
            with wave.open(io.BytesIO(result.stdout)) as wav:self.assertEqual(wav.readframes(wav.getnframes()),pcm)
            self.assertTrue(source.exists())
            encode_flac(source.read_bytes(),root/'stdin.flac')
            self.assertEqual(target.read_bytes(),(root/'stdin.flac').read_bytes())
    def test_invalid_audio_does_not_replace_target(self):
        with tempfile.TemporaryDirectory() as temp:
            target=Path(temp)/'voice.flac';target.write_bytes(b'previous')
            with self.assertRaises(RuntimeError):encode_flac(b'not WAV',target)
            self.assertEqual(target.read_bytes(),b'previous');self.assertFalse(list(Path(temp).glob('*.tmp')))


if __name__=='__main__':unittest.main()
