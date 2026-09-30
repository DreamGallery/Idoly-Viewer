import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from idoly_story_index.text_updates import text_changes, matching_history

class TextUpdatesTest(unittest.TestCase):
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
        pending={s['id'] for s in catalog['stories'] if not directory['stories'][s['id']]['indexVisible']}
        self.assertEqual({s['script_id'] for s in updates['items'] if s['pending']},pending)
        self.assertTrue(all(s['updated_at'] and s['commit'] and not s['script_id'].endswith('_short') for s in updates['items']))
