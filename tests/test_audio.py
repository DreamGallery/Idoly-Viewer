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
from idoly_story_index.audio import encode_flac, encode_audio
from idoly_story_index.voice_encoding import VoiceEncoding
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


    def test_lossy_cache_isolated_by_codec_and_bitrate_reuses_original_bundle(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);bundle=b'game-bundle';checksum=hashlib.md5(bundle).hexdigest()
            cache=root/checksum;cache.mkdir();(cache/'source.bundle').write_bytes(bundle)
            (cache/'voice.flac').write_bytes(b'original FLAC cache')
            pcm=b'RIFF\x00\x00\x00\x00WAVEgame audio'
            clip=SimpleNamespace(m_Name='voice',samples={'voice.wav':pcm})
            obj=SimpleNamespace(type=SimpleNamespace(name='AudioClip'),read=lambda:clip)
            plan={'images':[],'voices':{'voice':'bank'},'assets':{'bank':{'md5':checksum,'size':len(bundle)}}}
            def encode(value,target,encoding):
                self.assertEqual(value,pcm)
                target.write_bytes(encoding.label.encode());return target
            with patch('idoly_story_index.media.download_file') as download, \
                 patch('idoly_story_index.octo_source.decrypt_bundle',return_value=b'decoded'), \
                 patch('UnityPy.load',return_value=SimpleNamespace(objects=[obj])) as decode, \
                 patch('idoly_story_index.media.encode_audio',side_effect=encode) as encoder:
                for profile in (VoiceEncoding('mp3',64),VoiceEncoding('mp3',96),VoiceEncoding('aac',96)):
                    first=materialize('voice','voice',plan=plan,cache_root=root,voice_encoding=profile)
                    self.assertEqual(first.read_bytes(),profile.label.encode())
                    self.assertEqual(materialize('voice','voice',plan=plan,cache_root=root,voice_encoding=profile),first)
                self.assertEqual(encoder.call_count,3);self.assertEqual(decode.call_count,3)
                download.assert_not_called()
            self.assertEqual((cache/'voice.flac').read_bytes(),b'original FLAC cache')


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



@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required; run inside updater image')
class RealLossyTests(unittest.TestCase):
    def test_mp3_and_aac_valid_audio_smaller_than_pcm(self):
        import json
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for channels in (1, 2):
                source = root/'voice.wav'
                pcm = b''.join(struct.pack('<h', (i % 80 - 40)*200)*channels for i in range(44100))
                with wave.open(str(source), 'wb') as wav:
                    wav.setparams((channels, 2, 44100, 0, 'NONE', ''));wav.writeframes(pcm)
                for codec in ('mp3', 'aac'):
                    encoding = VoiceEncoding(codec, 96);target = root/('voice' + encoding.extension)
                    for value in (source, source.read_bytes()):
                        encode_audio(value, target, encoding)
                        result = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(target)], check=True, stdout=subprocess.PIPE)
                        stream = json.loads(result.stdout)['streams'][0]
                        self.assertEqual(stream['codec_name'], codec)
                        self.assertEqual(stream['channels'], channels)
                        self.assertLess(target.stat().st_size, len(pcm))
                        self.assertEqual(target.stat().st_mode & 0o777, 0o644)
                        self.assertFalse(list(root.glob('*.tmp')))

    def test_encoder_failure_preserves_target_and_removes_partial_file(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)/'voice.mp3';target.write_bytes(b'previous')
            wav_bytes = io.BytesIO()
            with wave.open(wav_bytes, 'wb') as wav:
                wav.setparams((1, 2, 44100, 0, 'NONE', ''));wav.writeframes(b'\x00'*8820)
            with patch('idoly_story_index.audio.subprocess.run', return_value=SimpleNamespace(returncode=1)):
                with self.assertRaises(RuntimeError):encode_audio(wav_bytes.getvalue(), target, VoiceEncoding('mp3', 96))
            self.assertEqual(target.read_bytes(), b'previous')
            self.assertFalse(list(Path(temp).glob('*.tmp')))


if __name__=='__main__':unittest.main()
