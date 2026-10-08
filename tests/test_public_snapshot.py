import csv
import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import shutil
from unittest.mock import patch

from idoly_story_index.public_text import original_csv, original_story
from idoly_story_index.publish import public_media_base, snapshot_plan
from idoly_story_index.runtime import build_snapshot, run_once


SOURCE_CSV = 'id,name,text,trans\r\n1:text:1,A,"原文,引用\n続き",PRIVATE_TRANSLATION\r\ninfo,adv_test.txt,source-hash,\r\n译者,PRIVATE_CREDIT,,\r\n'


class PublicTextTests(unittest.TestCase):
    def test_original_csv_preserves_source_and_removes_translations_and_credits(self):
        result = list(csv.DictReader(io.StringIO(original_csv(SOURCE_CSV))))
        self.assertEqual(result[0], {'id': '1:text:1', 'name': 'A', 'text': '原文,引用\n続き', 'trans': ''})
        self.assertEqual(result[1]['text'], 'source-hash')
        self.assertEqual(result[2], {'id': '译者', 'name': '', 'text': '', 'trans': ''})
        self.assertEqual(original_csv(original_csv(SOURCE_CSV)), original_csv(SOURCE_CSV))
        for invalid in ['name,text\nA,original', 'id,name,text,trans\n1,A,text,extra,extra', 'id,name,text,trans\n1,A']:
            with self.assertRaises(ValueError):
                original_csv(invalid)

    def test_legacy_story_is_rebuilt_from_public_fields_only(self):
        story = {'id': 'adv_test', 'originalTitle': '原題', 'title': 'PRIVATE_TITLE', 'script': 'original script',
                 'private': 'PRIVATE_EXTRA', 'humanLines': 1, 'translationStatus': 'human',
                 'rows': [{'id': '1:text:1', 'name': 'A', 'text': '原文', 'trans': 'PRIVATE_T', 'ai': 'PRIVATE_AI', 'human': 'PRIVATE_H', 'reviewed': 'PRIVATE_R', 'start': 4}],
                 'metadata': [{'id': '译者', 'name': 'PRIVATE_CREDIT', 'text': '', 'trans': ''}], 'names': {'A': 'PRIVATE_NAME'}}
        result = original_story(story)
        self.assertNotIn('PRIVATE_', json.dumps(result))
        self.assertEqual(result['rows'][0]['start'], 4)
        self.assertEqual(result['humanLines'], 1)


class PublicMediaTests(unittest.TestCase):
    def fixture(self, root):
        stage = root/'release'
        contents = {
            'story/card/adv_test.csv': SOURCE_CSV,
            'adv/adv_test.txt': '[message text=原文 name=A]',
            'media/voice/voice.flac': 'audio',
            'media/video/card.mp4': 'video',
            'media/image/cover.webp': 'cover',
            'web/images/icon.png': 'icon',
            'web/catalog/chapters/adv_test.json': json.dumps({'csv_path': 'card/adv_test.csv', 'label': '人工校对稿'}),
            'web/data/catalog.json': json.dumps({'image': '/images/icon.png'}),
            'web/data/music.json': json.dumps({'tracks': [{'audio': '/api/media/voice/voice.flac', 'cover': '/api/media/image/cover.webp'}]}),
            'web/data/directory.json': json.dumps({'videos': [{'url': '/api/media/video/card.mp4', 'poster': '/api/media/image/cover.webp'}], 'source': '/api/original/adv_test', 'external': 'https://official.test/image.png'}),
            'web/data/media/adv_test.json': json.dumps({'voices': {'lines': [{'clips': [{'url': '/api/media/voice/voice.flac'}]}]}}),
            'web/data/stories/adv_test.json': json.dumps({'id': 'adv_test', 'originalTitle': '原題', 'title': 'PRIVATE_TITLE', 'rows': [{'id': '1:text:1', 'name': 'A', 'text': '原文', 'trans': 'PRIVATE_TRANSLATION'}]}),
        }
        for logical, value in contents.items():
            path = stage/logical;path.parent.mkdir(parents=True, exist_ok=True);path.write_bytes(value.encode())
        return stage

    def test_direct_links_cover_all_media_and_only_original_text_is_packaged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory);stage = self.fixture(root)
            untouched = {path: path.read_bytes() for path in stage.rglob('*') if path.is_file()}
            shared = root/'shared.json';os.link(stage/'web/data/music.json', shared)
            files, jobs = snapshot_plan(stage, prefix='existing/prefix', public_base='https://media.example.test/')
            read = lambda logical: jobs[files[logical]][0].read_text()
            song = json.loads(read('web/data/music.json'))['tracks'][0]
            self.assertEqual(song['audio'], 'https://media.example.test/existing/prefix/'+files['media/voice/voice.flac'])
            self.assertEqual(song['cover'], 'https://media.example.test/existing/prefix/'+files['media/image/cover.webp'])
            listing = json.loads(read('web/data/directory.json'))
            self.assertEqual(listing['videos'][0]['url'], 'https://media.example.test/existing/prefix/'+files['media/video/card.mp4'])
            self.assertEqual(listing['source'], '/api/original/adv_test')
            self.assertEqual(listing['external'], 'https://official.test/image.png')
            self.assertIn(files['web/images/icon.png'], read('web/data/catalog.json'))
            self.assertIn(song['audio'], read('web/data/media/adv_test.json'))
            for key, (path, sha) in jobs.items():
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), sha)
                self.assertIn('/'+sha+'/', key)
                if key.startswith('text/'):
                    self.assertNotIn('PRIVATE_', path.read_text())
            self.assertEqual(json.loads(read('web/catalog/chapters/adv_test.json'))['label'], '原文')
            self.assertEqual(json.loads((stage/'file-map.json').read_text())['text_policy'], 'original-only')
            self.assertEqual(shared.read_bytes(), untouched[stage/'web/data/music.json'])
            for path, value in untouched.items():
                self.assertEqual(path.read_bytes(), value)
            second, _ = snapshot_plan(stage, prefix='existing/prefix', public_base='https://other.example.test')
            self.assertEqual(second['media/voice/voice.flac'], files['media/voice/voice.flac'])
            self.assertNotEqual(second['web/data/music.json'], files['web/data/music.json'])

    def test_unconfigured_domain_uses_same_origin_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = self.fixture(Path(directory));files, jobs = snapshot_plan(stage)
            library = json.loads(jobs[files['web/data/music.json']][0].read_text())
            self.assertEqual(library['tracks'][0]['audio'], '/'+files['media/voice/voice.flac'])

    def test_invalid_media_origin_is_rejected_before_any_publication(self):
        for value in ['http://media.test', 'https://user:secret@media.test', 'https://media.test/prefix', 'https://media.test?token=secret', 'https://media.test/#fragment', 'https://media.test:bad', 'https://media.test\\path']:
            with self.assertRaises(ValueError):public_media_base(value)
        self.assertEqual(public_media_base(' https://media.test/ '), 'https://media.test')


class OriginalRuntimeTests(unittest.TestCase):
    def test_data_builder_exports_original_dialogue_and_keeps_completion_counts(self):
        project = Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location('public_data_builder', project/'scripts/build-idoly-data.py')
        builder = importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory);master = root/'master';source = root/'source';translations = root/'translations';toolkit = root/'toolkit'
            for path in [master, source/'CSV/card', source/'Resource', translations/'glossary', translations/'master/zh-Hans', toolkit/'src']:
                path.mkdir(parents=True, exist_ok=True)
            for table in ['Character', 'CharacterGroup', 'Story', 'StoryPart', 'EventStory', 'ExtraStory', 'LoveStoryEpisode']:
                (master/(table+'.json')).write_text('[]')
            for file in ['glossary/names.json', 'glossary/terms.json', 'master/zh-Hans/Story.json']:
                (translations/file).write_text('{}')
            shutil.copyfile(project/'vendor/hoshimi/src/adv_csv.py', toolkit/'src/adv_csv.py')
            raw = '[message text=原文 name=A]\n';sha = hashlib.sha256(raw.encode()).hexdigest()
            csv_text = f'id,name,text,trans\n1:text:1,A,原文,\ninfo,adv_test.txt,{sha},\n译者,,,\n'
            (source/'CSV/card/adv_test.csv').write_text(csv_text);(source/'Resource/adv_test.txt').write_text(raw);(source/'revision').write_text('1055')
            for layer in ['ai', 'human', 'reviewed']:
                path = translations/'story'/layer/'card/adv_test.csv';path.parent.mkdir(parents=True)
                path.write_text(csv_text.replace('1:text:1,A,原文,', '1:text:1,A,原文,PRIVATE_'+layer))
            output = root/'web/data';report = root/'report.json'
            argv = ['build-idoly-data', '--master', str(master), '--source', str(source), '--translations', str(translations), '--toolkit', str(toolkit), '--output', str(output), '--report', str(report), '--original-only']
            with patch('sys.argv', argv), patch.object(builder.subprocess, 'check_output', return_value='a'*40), patch.object(builder, 'confirmed_exclusions', return_value=set()):
                builder.main()
            story = json.loads((output/'stories/adv_test.json').read_text())
            self.assertNotIn('PRIVATE_', json.dumps(story))
            self.assertEqual(story['rows'][0]['trans'], '')
            self.assertEqual(story['reviewedLines'], 1)
            self.assertEqual(story['translationStatus'], 'completed')
            self.assertEqual(json.loads(report.read_text())['warnings'], [])

    def test_snapshot_copies_original_csv_even_if_a_translation_exists(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory);stage = root/'release';source = root/'source';translations = root/'translations'
            for path, body in [(source/'CSV/card/adv_test.csv', SOURCE_CSV), (source/'Resource/adv_test.txt', 'raw original'),
                               (translations/'story/reviewed/card/adv_test.csv', 'invalid private CSV')]:
                path.parent.mkdir(parents=True, exist_ok=True);path.write_text(body)
            def data_build(args, **kwargs):
                self.assertIn('--original-only', args)
                for logical, value in {'data-validation.json': {'warnings': []}, 'web/data/catalog.json': {'stories': [{'id': 'adv_test', 'path': 'card/adv_test.csv'}]},
                                       'web/catalog/chapters/adv_test.json': {'csv_path': 'card/adv_test.csv'}, 'web/catalog/manifest.json': {}}.items():
                    path = stage/logical;path.parent.mkdir(parents=True, exist_ok=True);path.write_text(json.dumps(value))
            with patch('idoly_story_index.runtime.seed_images'), patch('idoly_story_index.runtime.subprocess.run', side_effect=data_build), patch('idoly_story_index.runtime.build'), patch('idoly_story_index.runtime.add_music_snapshot'):
                build_snapshot(root, stage, root/'master', root/'toolkit', source, translations, {}, with_media=False)
            self.assertNotIn('PRIVATE_', (stage/'story/card/adv_test.csv').read_text())
            self.assertIn('原文,引用', (stage/'story/card/adv_test.csv').read_text())
            self.assertEqual((stage/'adv/adv_test.txt').read_text(), 'raw original')

    def test_changing_media_origin_creates_a_new_index_without_a_game_update(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch('idoly_story_index.runtime.sync_repo', return_value=(root/'source', 'a'*40)), patch('idoly_story_index.runtime.fetch_master', return_value=(root/'master', {})), patch('idoly_story_index.runtime.update_manifest', return_value={'revision': 1}), patch('idoly_story_index.runtime.digest', return_value='manifest-hash'), patch('idoly_story_index.runtime.build_snapshot'), patch('idoly_story_index.runtime.prepare_archives', return_value={'versions': []}):
                for origin in ['https://first.example.test', 'https://second.example.test']:
                    run_once(root, env={'IDOLY_R2_PUBLIC_BASE_URL': origin}, prepare_only=True)
            releases = list((root/'releases').glob('*/complete.json'))
            self.assertEqual(len(releases), 2)
            self.assertEqual({json.loads(path.read_text())['inputs']['public_media_base'] for path in releases}, {'https://first.example.test', 'https://second.example.test'})


if __name__ == '__main__':
    unittest.main()
