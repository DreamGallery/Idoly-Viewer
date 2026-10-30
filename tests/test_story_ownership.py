import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from idoly_story_index.build import build, event_sort_time
from idoly_story_index.story_ownership import StoryOwnershipIndex


ROOT = Path(__file__).resolve().parents[1]


def master_tables():
    return {name: [] for name in ['Character', 'CharacterGroup', 'Card', 'CardEvolution',
        'Story', 'StoryPart', 'EventStory', 'ExtraStory', 'ExtraStoryPart',
        'LoveStoryEpisode', 'Skill', 'PhotoAllInOne']}


def episode(story_id, asset):
    return {'episode': 1, 'storyId': story_id, 'assetId': asset}


class StoryOwnershipTest(unittest.TestCase):
    def test_event_uses_master_membership_even_with_main_folder_and_shelf_alias(self):
        tables = master_tables()
        tables['Story'] = [
            {'id': 'event-story', 'advAssetIds': ['main_04_15_01']},
            {'id': 'shelf-copy', 'advAssetIds': ['main_04_15_01']},
        ]
        tables['EventStory'] = [{'episodes': [episode('event-story', 'main_04_15_01')]}]
        self.assertEqual(StoryOwnershipIndex(tables).resolve('main_04_15_01', 'main'),
                         ('event', 'event-story'))

    def test_primary_main_and_group_chapters_win_over_archived_copies(self):
        for part_type, category in [(1, 'main'), (2, 'group'), (3, 'main')]:
            with self.subTest(category=category, part_type=part_type):
                tables = master_tables()
                tables['Story'] = [
                    {'id': 'primary', 'advAssetIds': ['shared']},
                    {'id': 'archive', 'advAssetIds': ['shared']},
                ]
                tables['ExtraStory'] = [{'extraStoryPartId': 'limited', 'episodes': [episode('archive', 'shared')]}]
                tables['StoryPart'] = [{'type': part_type, 'chapters': [{'episodes': [episode('primary', 'shared')]}]}]
                self.assertEqual(StoryOwnershipIndex(tables).resolve('shared', 'event'), (category, 'primary'))

    def test_birthday_parent_is_not_classified_as_an_event(self):
        tables = master_tables()
        tables['Story'] = [{'id': 'birthday', 'advAssetIds': ['hbd_02_ai']}]
        tables['ExtraStoryPart'] = [{'id': 'birthdays', 'assetId': 'birthday-01'}]
        tables['ExtraStory'] = [{'extraStoryPartId': 'birthdays', 'episodes': [episode('birthday', 'hbd_2022')]}]
        self.assertEqual(StoryOwnershipIndex(tables).resolve('hbd_02_ai', 'event'), ('hbd', 'birthday'))

    def test_card_bond_love_and_branch_scripts_use_explicit_relationships(self):
        tables = master_tables()
        tables['Story'] = [
            {'id': 'card-story', 'advAssetIds': ['card-script'], 'branchChoices': [{'advAssetId': 'card-choice'}]},
            {'id': 'bond-story', 'advAssetIds': ['bond-script']},
            {'id': 'love-story', 'advAssetIds': ['love-script']},
        ]
        tables['Card'] = [{'stories': [{'storyId': 'card-story'}]}]
        tables['Character'] = [{'companyEnjoyStories': [episode('bond-story', '01')]}]
        tables['LoveStoryEpisode'] = [episode('love-story', 'love-script')]
        index = StoryOwnershipIndex(tables)
        for asset, category, story_id in [('card-script', 'card', 'card-story'), ('card-choice', 'card', 'card-story'),
                                          ('bond-script', 'bond', 'bond-story'), ('love-script', 'love', 'love-story')]:
            self.assertEqual(index.resolve(asset, 'main'), (category, story_id))
        self.assertEqual(index.resolve('01', 'event'), ('event', None))

    def test_unowned_story_and_unknown_script_keep_csv_fallback(self):
        tables = master_tables()
        tables['Story'] = [{'id': 'unowned', 'advAssetIds': ['loose-script']}]
        index = StoryOwnershipIndex(tables)
        self.assertEqual(index.resolve('loose-script', 'hbd'), ('hbd', 'unowned'))
        self.assertEqual(index.resolve('missing', 'main'), ('main', None))

    def test_missing_story_row_can_still_have_an_explicit_episode_membership(self):
        tables = master_tables()
        tables['EventStory'] = [{'episodes': [episode('event-story', 'script')]}]
        self.assertEqual(StoryOwnershipIndex(tables).resolve('script', 'main'), ('event', 'event-story'))

    def test_reused_display_asset_does_not_replace_the_actual_script_record(self):
        tables = master_tables()
        tables['Story'] = [{'id': 'one', 'advAssetIds': ['script-one']}, {'id': 'two', 'advAssetIds': ['script-two']}]
        tables['EventStory'] = [{'episodes': [episode('one', 'script-one'), episode('two', 'script-one')]}]
        index = StoryOwnershipIndex(tables)
        self.assertEqual(index.resolve('script-one', 'main'), ('event', 'one'))
        self.assertEqual(index.resolve('script-two', 'main'), ('event', 'two'))

    def test_ambiguous_primary_membership_is_not_resolved_by_csv_folder(self):
        tables = master_tables()
        tables['Story'] = [{'id': 'shared', 'advAssetIds': ['script']}]
        tables['StoryPart'] = [{'type': kind, 'chapters': [{'episodes': [episode('shared', 'script')]}]} for kind in [1, 2]]
        with self.assertRaisesRegex(ValueError, 'Conflicting MasterDB categories'):
            StoryOwnershipIndex(tables)

    def test_event_date_can_come_from_master_asset_without_replacing_original_month(self):
        self.assertEqual(event_sort_time(['adv_main_04_15_01'], 'event-dice-26-1030'), 1793318400000)
        self.assertEqual(event_sort_time(['adv_event_2206_01_01'], 'event-rerun-26-1030'),
                         event_sort_time(['adv_event_2206_01_01']))
        self.assertIsNone(event_sort_time(['adv_main_04_15_01'], 'event-dice-26-1330'))


class StoryOwnershipPipelineTest(unittest.TestCase):
    def test_catalog_chapter_directory_updates_and_cover_agree_without_moving_csv(self):
        spec = importlib.util.spec_from_file_location('ownership_data_builder', ROOT/'scripts/build-idoly-data.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        temporary_root = ROOT/'.agent-local/tests/story-ownership'
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary_root) as folder:
            root = Path(folder)
            master, source, translations, toolkit, output = [root/name for name in ['master', 'source', 'translations', 'toolkit', 'web/data']]
            for path in [master, source/'CSV/main', source/'Resource', translations/'glossary',
                         translations/'master/zh-Hans', toolkit/'src', toolkit/'cache']:
                path.mkdir(parents=True, exist_ok=True)
            tables = master_tables()
            event_id = 'st-eve-2610-dice'
            assets = [f'main_04_15_{n:02}' for n in range(1, 7)]
            tables['Story'] = [
                {'id': f'{prefix}-{n:03}', 'name': f'Episode {n}', 'advAssetIds': [asset]}
                for prefix in [event_id, 'st-shelf-copy'] for n, asset in enumerate(assets, 1)
            ]
            tables['EventStory'] = [{'id': event_id, 'assetId': 'event-dice-26-1030',
                'description': 'After Story', 'episodes': [
                    {**episode(f'{event_id}-{n:03}', asset), 'episode': n} for n, asset in enumerate(assets, 1)
                ]}]
            for name, rows in tables.items():
                (master/(name+'.json')).write_text(json.dumps(rows))
            for file in ['glossary/names.json', 'glossary/terms.json', 'master/zh-Hans/Story.json']:
                (translations/file).write_text('{}')
            shutil.copyfile(ROOT/'vendor/hoshimi/src/adv_csv.py', toolkit/'src/adv_csv.py')
            banner = 'img_story_event_banner_event-dice-26-1030'
            (toolkit/'cache/OctoManifest.json').write_text(json.dumps({
                'revision': 1083, 'urlFormat': 'https://example.invalid/{o}',
                'assetBundleList': [{'name': banner}], 'resourceList': [],
            }))
            (source/'revision').write_text('1083')
            raw = '[message text=原文 name=A]\n'
            for asset in assets:
                sid = 'adv_'+asset
                (source/'Resource'/(sid+'.txt')).write_text(raw)
                (source/'CSV/main'/(sid+'.csv')).write_text(
                    f'id,name,text,trans\n1:text:1,A,原文,\ninfo,{sid}.txt,{hashlib.sha256(raw.encode()).hexdigest()},\n译者,,,\n')
            argv = ['build-idoly-data', '--master', str(master), '--source', str(source),
                    '--translations', str(translations), '--toolkit', str(toolkit), '--output', str(output),
                    '--report', str(root/'data-report.json'), '--original-only']
            with patch('sys.argv', argv), patch.object(builder.subprocess, 'check_output', return_value='a'*40), \
                    patch.object(builder, 'confirmed_exclusions', return_value=set()):
                builder.main()
            changes = {'CSV/main/adv_'+asset+'.csv': {'at': 1793318400000, 'kind': 'added', 'commit': 'a'*40} for asset in assets}
            with patch('idoly_story_index.build.confirmed_exclusions', return_value=set()), \
                    patch('idoly_story_index.text_updates.text_changes', return_value=changes):
                build(master, toolkit, source, translations, output, report=root/'index-report.json', history_cache=None)
            catalog = json.loads((output/'catalog.json').read_text())
            directory = json.loads((output/'directory.json').read_text())
            updates = json.loads((output/'updates.json').read_text())
            ids = ['adv_'+asset for asset in assets]
            self.assertNotIn('main:unmapped', directory['nodes'])
            node = directory['nodes'][event_id]
            self.assertEqual(node['parent'], 'event:normal')
            self.assertEqual(node['stories'], ids)
            self.assertEqual(node['count'], 6)
            self.assertEqual(node['images'][0]['asset'], banner)
            self.assertEqual(node['sortTime'], 1793318400000)
            for story in catalog['stories']:
                self.assertEqual(story['category'], 'event')
                self.assertEqual(story['path'], 'main/'+story['id']+'.csv')
                shard = json.loads((output/'stories'/(story['id']+'.json')).read_text())
                self.assertEqual(shard['category'], 'event')
                self.assertEqual(shard['path'], story['path'])
                chapter = json.loads((output.parent/'catalog/chapters'/(story['id']+'.json')).read_text())
                self.assertEqual(chapter['csv_path'], story['path'])
                self.assertEqual(directory['stories'][story['id']]['group'], event_id)
                self.assertTrue(directory['stories'][story['id']]['indexVisible'])
            self.assertEqual(len(updates['items']), 6)
            self.assertTrue(all(row['category_id'] == 'event' and row['group_id'] == event_id and not row['pending']
                                and row['images'][0]['asset'] == banner for row in updates['items']))


if __name__ == '__main__':
    unittest.main()
