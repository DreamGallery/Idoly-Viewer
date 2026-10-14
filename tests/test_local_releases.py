from contextlib import ExitStack, contextmanager
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from idoly_story_index.runtime import cleanup_local_releases, run_once


OLD='idoly-r1-'+'a'*16
PREVIOUS='idoly-r2-'+'b'*16
CURRENT='idoly-r3-'+'c'*16
NEXT='idoly-r4-'+'d'*16


def release(root,name,base=None,complete=True):
    path=root/'releases'/name
    path.mkdir(parents=True)
    (path/'content').write_text(name)
    if complete:
        (path/'complete.json').write_text(json.dumps({'base_release':base,'fingerprint':name}))
    return path


class LocalReleaseTests(unittest.TestCase):
    def test_keeps_current_and_its_baseline_not_the_newest_directories(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            previous=release(root,PREVIOUS)
            current=release(root,CURRENT,PREVIOUS)
            old=release(root,OLD)
            abandoned=release(root,NEXT,complete=False)
            os.utime(previous,(1,1));os.utime(current,(2,2))
            cleanup_local_releases(root,CURRENT)
            self.assertTrue(current.is_dir());self.assertTrue(previous.is_dir())
            self.assertFalse(old.exists());self.assertFalse(abandoned.exists())
            cleanup_local_releases(root,CURRENT)
            self.assertTrue(current.is_dir());self.assertTrue(previous.is_dir())

    def test_shared_hardlinks_caches_repositories_archives_and_unknown_paths_survive(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            current=release(root,CURRENT)
            old=release(root,OLD)
            files=[root/'cache/media/audio.flac',root/'repos/source/CSV/story.csv',
                   root/'downloads/archive.tar.gz',root/'releases/manual-backup/note']
            for path in files:
                path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'keep')
            os.link(files[0],old/'audio.flac');os.link(files[0],current/'audio.flac')
            outside=root/'outside';outside.mkdir();(outside/'file').write_text('keep')
            (root/'releases'/PREVIOUS).symlink_to(outside,target_is_directory=True)
            (old/'external').symlink_to(outside,target_is_directory=True)
            (root/'releases'/NEXT).write_text('not a directory')
            cleanup_local_releases(root,CURRENT)
            self.assertFalse(old.exists())
            self.assertTrue((root/'releases'/PREVIOUS).is_symlink())
            self.assertEqual((outside/'file').read_text(),'keep')
            self.assertEqual((root/'releases'/NEXT).read_text(),'not a directory')
            self.assertEqual((current/'audio.flac').read_bytes(),b'keep')
            self.assertTrue(os.path.samefile(files[0],current/'audio.flac'))
            for path in files:self.assertEqual(path.read_bytes(),b'keep')

    def test_invalid_or_missing_published_metadata_prevents_cleanup(self):
        for metadata in [None,'{broken','[]','{}','{"base_release":"../outside"}']:
            with self.subTest(metadata=metadata),tempfile.TemporaryDirectory() as temp:
                root=Path(temp);old=release(root,OLD)
                current=release(root,CURRENT,complete=False)
                if metadata is not None:(current/'complete.json').write_text(metadata)
                cleanup_local_releases(root,CURRENT)
                self.assertTrue(old.is_dir());self.assertTrue(current.is_dir())

    def test_symlinked_releases_root_or_current_is_not_cleaned(self):
        for linked_root in [True,False]:
            with self.subTest(linked_root=linked_root),tempfile.TemporaryDirectory() as temp:
                root=Path(temp);outside=root/'outside'
                current=release(outside,CURRENT);old=release(outside,OLD)
                if linked_root:
                    (root/'releases').symlink_to(outside/'releases',target_is_directory=True)
                else:
                    release(root,OLD)
                    (root/'releases'/CURRENT).symlink_to(current,target_is_directory=True)
                cleanup_local_releases(root,CURRENT)
                self.assertTrue(old.is_dir());self.assertTrue(current.is_dir())
                self.assertTrue((root/'releases'/OLD).is_dir())

    def test_permission_failure_is_logged_and_retried_later(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);release(root,CURRENT);old=release(root,OLD)
            with patch('idoly_story_index.runtime.shutil.rmtree',side_effect=PermissionError),patch('sys.stdout',new_callable=io.StringIO) as log:
                cleanup_local_releases(root,CURRENT)
                self.assertIn('removed=0 deferred=1',log.getvalue())
            self.assertTrue(old.exists())
            cleanup_local_releases(root,CURRENT)
            self.assertFalse(old.exists())


class RuntimeCleanupTests(unittest.TestCase):
    @contextmanager
    def dependencies(self,root,identity='d'*64):
        def archives(_root,stage,*args):
            versions={'versions':[]}
            (stage/'resource-versions.json').write_text(json.dumps(versions))
            return versions
        with ExitStack() as stack:
            mocks={}
            for name,kwargs in {
                'connect':{'return_value':(Mock(),'bucket','prefix')},
                'read_current':{'return_value':({'release':CURRENT,'versions':{'versions':[]}},'etag')},
                'sync_repo':{'return_value':(root/'source','a'*40)},
                'fetch_master':{'return_value':(root/'master',{})},
                'update_manifest':{'return_value':{'revision':4}},
                'digest':{'return_value':'manifest'},
                'fingerprint':{'return_value':identity},
                'build_snapshot':{},
                'prepare_archives':{'side_effect':archives},
                'publish':{},
            }.items():
                mocks[name]=stack.enter_context(patch('idoly_story_index.runtime.'+name,**kwargs))
            yield mocks

    def fixture(self,root):
        release(root,OLD);release(root,PREVIOUS,OLD);release(root,CURRENT,PREVIOUS)

    def test_publish_failure_preserves_every_release_and_retry_cleans_only_after_success(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);self.fixture(root)
            with self.dependencies(root) as mocks:
                mocks['publish'].side_effect=RuntimeError('upload failed')
                with self.assertRaisesRegex(RuntimeError,'upload failed'):run_once(root,env={})
                for name in (OLD,PREVIOUS,CURRENT,NEXT):self.assertTrue((root/'releases'/name).is_dir())
                self.assertFalse((root/'last-success.json').exists())
                def publish(*args,**kwargs):
                    for name in (OLD,PREVIOUS,CURRENT,NEXT):self.assertTrue((root/'releases'/name).is_dir())
                mocks['publish'].side_effect=publish
                run_once(root,env={})
                self.assertEqual(mocks['build_snapshot'].call_count,1)
                self.assertEqual(json.loads((root/'last-success.json').read_text())['release'],NEXT)
                self.assertEqual({p.name for p in (root/'releases').iterdir()},{CURRENT,NEXT})

    def test_unchanged_release_still_cleans_without_uploading(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);self.fixture(root)
            with self.dependencies(root,identity=CURRENT) as mocks:
                run_once(root,env={})
                mocks['build_snapshot'].assert_not_called();mocks['publish'].assert_not_called()
            self.assertEqual({p.name for p in (root/'releases').iterdir()},{PREVIOUS,CURRENT})

    def test_preparation_and_failed_build_do_not_clean(self):
        for prepare_only in (True,False):
            with self.subTest(prepare_only=prepare_only),tempfile.TemporaryDirectory() as temp:
                root=Path(temp);self.fixture(root)
                with self.dependencies(root) as mocks:
                    if prepare_only:run_once(root,env={},prepare_only=True)
                    else:
                        mocks['build_snapshot'].side_effect=RuntimeError('decode failed')
                        with self.assertRaisesRegex(RuntimeError,'decode failed'):run_once(root,env={})
                    mocks['publish'].assert_not_called()
                for name in (OLD,PREVIOUS,CURRENT,NEXT):self.assertTrue((root/'releases'/name).is_dir())


if __name__=='__main__':unittest.main()
