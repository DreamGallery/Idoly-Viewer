import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from idoly_story_index.text_updates import build_updates, text_changes, matching_history

class TextUpdatesTest(unittest.TestCase):
    def test_birthday_updates_use_memorial_photo_without_changing_other_groups(self):
        from unittest.mock import patch
        ids=('adv_hbd_01_szk','adv_userhbd_01_szk','adv_bond_szk_01_01')
        catalog={'provenance':{'sourceCommit':'source'},'stories':[
            {'id':sid,'path':sid+'.csv','title':sid,'category':'bond' if 'bond' in sid else 'hbd','characters':['szk'],'lines':1} for sid in ids]}
        photo=[{'asset':'img_photo_full_phot-birthday-23-1015-szk','url':'/birthday.webp','aspect_ratio':16/9,'frame_url':'/images/photos/photo_frame_5.png'}]
        portraits=[{'url':'/casual.png'},{'url':'/stage.png'}]
        nodes={
            'hbd':{'parent':None,'label':'生日剧情','images':[]},
            'hbd:szk':{'parent':'hbd','label':'兵藤雫','images':photo},
            'year':{'parent':'hbd:szk','label':'2023年','images':[{'url':'/old-scene.webp'}]},
            'player':{'parent':'hbd:szk','label':'玩家生日','images':[]},
            'bond':{'parent':None,'label':'羁绊剧情','images':[]},
            'bond:szk':{'parent':'bond','label':'兵藤雫','images':portraits,'portraitCover':True},
        }
        media={sid:{'group':group,'indexVisible':True} for sid,group in zip(ids,['year','player','bond:szk'])}
        changes={'CSV/'+sid+'.csv':{'at':100,'kind':'added','commit':'source'} for sid in ids}
        with patch('idoly_story_index.text_updates.text_changes',return_value=changes):
            rows={r['script_id']:r for r in build_updates(Path('.'),catalog,nodes,media)['items']}
        for sid in ids[:2]:
            self.assertEqual(rows[sid]['images'],photo)
            self.assertFalse(rows[sid]['portrait_cover'])
            self.assertNotIn('10月15日',rows[sid]['group_title'])
        self.assertEqual(rows[ids[0]]['group_title'],'兵藤雫 · 2023年')
        self.assertEqual(rows[ids[2]]['images'],portraits)
        self.assertTrue(rows[ids[2]]['portrait_cover'])

    def test_update_feed_ignores_translation_revisions(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, translations = Path(tmp)/'source', Path(tmp)/'translations'
            def git(root, *args, **kwargs):
                return subprocess.check_output(['git', '-C', str(root), '-c', 'commit.gpgsign=false', *args], text=True, **kwargs).strip()
            def commit(root, message, date):
                git(root, 'add', '.')
                git(root, 'commit', '-qm', message, env={**os.environ, 'GIT_AUTHOR_DATE': date, 'GIT_COMMITTER_DATE': date})
                return git(root, 'rev-parse', 'HEAD')
            for root in (source, translations):
                root.mkdir()
                git(root, 'init', '-q')
                git(root, 'config', 'user.name', 'Test')
                git(root, 'config', 'user.email', 'test@example.invalid')
            (source/'CSV').mkdir()
            for sid in ('adv_modified', 'adv_added'):
                (source/'CSV'/f'{sid}.csv').write_text('original')
            added_commit = commit(source, 'add source', '2026-09-20T00:00:00Z')
            (source/'CSV/adv_modified.csv').write_text('updated original')
            modified_commit = commit(source, 'modify source', '2026-09-25T00:00:00Z')
            (source/'Resource').mkdir()
            (source/'Resource/adv_modified.txt').write_text('script-only update')
            source_commit = commit(source, 'update script', '2026-09-26T00:00:00Z')
            (translations/'story/human').mkdir(parents=True)
            translated = translations/'story/human/adv_modified.csv'
            translated.write_text('translation')
            translation_commit = commit(translations, 'add translation', '2026-09-28T00:00:00Z')
            ids = ('adv_modified', 'adv_added', 'adv_pending')
            catalog = {'provenance': {'sourceCommit': source_commit, 'translationCommit': translation_commit},
                       'stories': [{'id': sid, 'path': sid+'.csv', 'title': sid, 'category': 'main', 'characters': [], 'lines': 1} for sid in ids]}
            nodes = {'main': {'parent': None, 'label': '主线剧情', 'images': []}}
            media = {sid: {'group': 'main', 'indexVisible': sid != 'adv_pending'} for sid in ids}
            updates = build_updates(source, catalog, nodes, media)
            rows = {row['script_id']: row for row in updates['items']}
            self.assertEqual((rows['adv_modified']['change_kind'], rows['adv_modified']['commit']), ('modified', modified_commit))
            self.assertEqual((rows['adv_added']['change_kind'], rows['adv_added']['commit']), ('added', added_commit))
            self.assertTrue(rows['adv_pending']['pending'])
            self.assertIsNone(rows['adv_pending']['updated_at'])
            self.assertTrue(all(row['origin'] == '原文' and row['repo'] == 'Hoshimi-Adv' and row['csv_path'].startswith('CSV/') for row in rows.values()))
            self.assertNotIn('translation_commit', updates)
            translated.write_text('revised translation')
            catalog['provenance']['translationCommit'] = commit(translations, 'revise translation', '2026-09-30T00:00:00Z')
            self.assertEqual(build_updates(source, catalog, nodes, media), updates)

    def test_history_uses_snapshot_commit_not_file_mtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            def git(*args, **kwargs):
                return subprocess.check_output(['git','-C',str(root),*args],text=True,**kwargs).strip()
            git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid')
            (root/'CSV').mkdir()
            file=root/'CSV/adv_main_01.csv';file.write_text('first')
            git('add','CSV')
            env={**os.environ,'GIT_AUTHOR_DATE':'2026-09-20T00:00:00Z','GIT_COMMITTER_DATE':'2026-09-20T00:00:00Z'}
            git('commit','-qm','add',env=env);original=git('rev-parse','HEAD')
            first=text_changes(root,original)['CSV/adv_main_01.csv']
            file.write_text('changed');git('add','CSV')
            env.update(GIT_AUTHOR_DATE='2026-09-25T00:00:00Z',GIT_COMMITTER_DATE='2026-09-25T00:00:00Z')
            git('commit','-qm','modify',env=env)
            self.assertEqual(text_changes(root,original)['CSV/adv_main_01.csv'],first)
            latest=text_changes(root,'HEAD')['CSV/adv_main_01.csv']
            self.assertEqual(first['kind'],'added');self.assertEqual(latest['kind'],'modified')
            self.assertGreater(latest['at'],first['at'])
            file.write_text('uncommitted change')
            self.assertEqual(text_changes(root,'HEAD')['CSV/adv_main_01.csv'],latest)
            cache=root/'history.git'
            git('clone','--bare','-q',str(root),str(cache))
            catalog={'stories':[{'path':'adv_main_01.csv'}], 'provenance':{'sourceCommit':original}}
            self.assertEqual(matching_history(root,catalog,cache),(root,original))
            file.write_text('changed')
            self.assertEqual(matching_history(root,catalog,cache),(cache,latest['commit']))

    def test_generated_updates_match_visible_index(self):
        import json
        root=Path(__file__).resolve().parents[1]/'public/data'
        catalog=json.loads((root/'catalog.json').read_text())
        updates=json.loads((root/'updates.json').read_text())
        directory=json.loads((root/'directory.json').read_text())
        expected={s['id'] for s in catalog['stories']}
        self.assertEqual({s['script_id'] for s in updates['items']},expected)
        self.assertEqual(len(updates['items']),len(expected))
        self.assertEqual(updates['catalog_source_commit'],catalog['provenance']['sourceCommit'])
        self.assertTrue(all(s['origin']=='原文' and s['repo']=='Hoshimi-Adv' and s['csv_path'].startswith('CSV/') for s in updates['items']))
        pending={s['id'] for s in catalog['stories'] if not directory['stories'][s['id']]['indexVisible']}
        self.assertEqual({s['script_id'] for s in updates['items'] if s['pending']},pending)
        self.assertTrue(all(s['updated_at'] and s['commit'] and not s['script_id'].endswith('_short') for s in updates['items']))
