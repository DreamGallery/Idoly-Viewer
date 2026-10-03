import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from idoly_story_index.build import voice_links
from idoly_story_index.runtime import materialize_snapshot, fingerprint
from idoly_story_index.voice_encoding import VoiceEncoding, load_voice_encoding


class EncodingSettingsTests(unittest.TestCase):
    def test_first_selection_survives_restart_without_environment(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            # Existing releases do not prevent explicit selection on the first feature use.
            (root/'releases/old').mkdir(parents=True)
            selected = load_voice_encoding(root, {'IDOLY_VOICE_CODEC': 'aac', 'IDOLY_VOICE_BITRATE': '64'})
            self.assertEqual(selected, VoiceEncoding('aac', 64))
            self.assertEqual(load_voice_encoding(root, {}), selected)
            before = (root/'voice-encoding.json').read_bytes()
            for env in ({'IDOLY_VOICE_CODEC': 'mp3'}, {'IDOLY_VOICE_BITRATE': '96'}):
                with self.assertRaisesRegex(ValueError, 'locked'):
                    load_voice_encoding(root, env)
                self.assertEqual((root/'voice-encoding.json').read_bytes(), before)
            self.assertEqual((root/'voice-encoding.json').stat().st_mode & 0o777, 0o644)

    def test_default_and_invalid_configuration(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for env in ({'IDOLY_VOICE_CODEC': 'opus'}, {'IDOLY_VOICE_CODEC': 'aac', 'IDOLY_VOICE_BITRATE': '96k'},
                        {'IDOLY_VOICE_CODEC': 'mp3', 'IDOLY_VOICE_BITRATE': '1'}):
                with self.assertRaises(ValueError):load_voice_encoding(root, env)
                self.assertFalse((root/'voice-encoding.json').exists())
            self.assertEqual(load_voice_encoding(root, {}), VoiceEncoding())
            (root/'voice-encoding.json').write_text('{broken')
            with self.assertRaisesRegex(ValueError, 'restore'):load_voice_encoding(root, {})

    def test_snapshot_identity_changes_with_encoding_and_bitrate(self):
        identities = {fingerprint({'voice_encoding': p.to_dict()}) for p in (
            VoiceEncoding(), VoiceEncoding('mp3', 64), VoiceEncoding('mp3', 96), VoiceEncoding('aac', 96))}
        self.assertEqual(len(identities), 4)

    def test_dialogue_index_uses_selected_extension(self):
        script = '\n'.join([
            '[message text=hello name=愛 clip={"_startTime":1,"_duration":2}]',
            '[voice voice=sud_vo_adv_test-ai001 actorId=ai clip={"_startTime":1,"_duration":2}]'])
        for extension in ('.flac', '.mp3', '.m4a'):
            links = voice_links(script, [{'id': '1:text:1', 'text': 'hello', 'name': '愛'}], {'sud_vo_adv_test': {}}, extension)
            self.assertEqual(links[0]['clips'][0]['url'], '/api/media/voice/sud_vo_adv_test-ai001' + extension)

    def test_snapshot_reuses_selected_cache_and_keeps_music_flac(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); stage = root/'release'; data = stage/'web/data';data.mkdir(parents=True)
            plan = {'images': [], 'videos': {}, 'voices': {'line': 'sud_vo_adv_test', 'song': 'sud_music_short_test'},
                    'assets': {'sud_vo_adv_test': {'md5': 'dialogue'}, 'sud_music_short_test': {'md5': 'music'}}}
            (data/'catalog.json').write_text('{"characters":[]}')
            (data/'media-plan.json').write_text(json.dumps(plan))
            selected = root/'cache/media/dialogue/voice-aac-64/line.m4a'
            song = root/'cache/media/music/song.flac'
            for file in (selected, song):file.parent.mkdir(parents=True, exist_ok=True);file.write_bytes(b'audio')
            from idoly_story_index.runtime import load
            def read(path):
                return {} if path.name == 'image-assets.json' else load(path)
            with patch('idoly_story_index.runtime.load', side_effect=read), \
                    patch('idoly_story_index.media.download_file') as download:
                materialize_snapshot(root, stage, {'assetBundleList': []}, 1, VoiceEncoding('aac', 64))
                download.assert_not_called()
            self.assertEqual((stage/'media/voice/line.m4a').read_bytes(), b'audio')
            self.assertEqual((stage/'media/voice/song.flac').read_bytes(), b'audio')
            self.assertFalse((stage/'media/voice/line.flac').exists())


if __name__ == '__main__':unittest.main()
