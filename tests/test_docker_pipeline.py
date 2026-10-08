import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from idoly_story_index.game_archive import portable_member, prepare_archives, snapshot, stretch_size, write_archive
from idoly_story_index.master_source import TABLES, artifact_tables, unpack_table
from idoly_story_index.publish import inventory_for, publish, snapshot_plan, upload_batch
from idoly_story_index.octo_source import decrypt_bundle


class MasterTests(unittest.TestCase):
    def artifact(self,missing=None):
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,'w') as archive:
            archive.writestr('!version.txt','version-id')
            for name in TABLES:
                if name!=missing:archive.writestr(name+'.json','[{"id":"one"}]')
            archive.writestr('../../do-not-extract','unsafe')
        return stream.getvalue()
    def test_complete_artifact_reads_only_required_tables(self):
        tables,version=artifact_tables(self.artifact())
        self.assertEqual(set(tables),set(TABLES));self.assertEqual(version,'version-id')
    def test_incomplete_artifact_rejected(self):
        with self.assertRaises(ValueError):artifact_tables(self.artifact('Story'))
    def test_compressed_json_supported_and_schema_checked(self):
        self.assertEqual(json.loads(unpack_table('Reward.json.gz',gzip.compress(b'[{"id":1}]'))),[{'id':1}])
        with self.assertRaises(ValueError):unpack_table('Story.json',b'{}')


class ArchiveTests(unittest.TestCase):
    def test_permissions_strip_private_modes_and_acl(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); source=root/'src'; source.mkdir();(source/'dir').mkdir(mode=0o700)
            (source/'dir/private-mode.txt').write_text('public resource');(source/'dir/private-mode.txt').chmod(0o600)
            target=root/'archive.tar.gz';write_archive(source,target)
            with tarfile.open(target) as archive:
                for member in archive.getmembers():
                    self.assertEqual(member.mode,0o755 if member.isdir() else 0o644)
                    self.assertEqual((member.uid,member.gid,member.uname,member.gname),(0,0,'',''))
            self.assertEqual(target.stat().st_mode&0o777,0o644)
            first=target.read_bytes();write_archive(source,target);self.assertEqual(target.read_bytes(),first)
        item=tarfile.TarInfo('file');item.pax_headers={'SCHILY.acl.access':'bad','SCHILY.mode':'0600'}
        self.assertFalse(portable_member(item).pax_headers)
    def test_links_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'src').mkdir();(root/'outside').write_text('private')
            (root/'src/link').symlink_to(root/'outside')
            with self.assertRaises(ValueError):write_archive(root/'src',root/'out.tar.gz')
    def test_idoly_stretch_rules(self):
        self.assertEqual(stretch_size('img_card_full_2_ktn-01'),(2560,1440))
        self.assertIsNone(stretch_size('img_ui_hero_event_01'))
    def test_full_increment_contains_changes_and_removals_and_keeps_five(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); old=root/'old';old.mkdir();stage=root/'new';stage.mkdir()
            (old/'resource-snapshot.json').write_text(json.dumps({'revision':'1','resources':{'assetBundleList/deleted':{'md5':'old','size':1}}}))
            (old/'resource-versions.json').write_text(json.dumps({'versions':[{'revision':str(n),'filename':str(n)} for n in range(6,0,-1)]}))
            manifest={'revision':7,'assetBundleList':[{'name':'img_card_full_1_test','md5':'new','size':3}],
                      'resourceList':[{'name':'adv_unindexed.txt','md5':'new','size':3}]}
            def fake_extract(manifest,kind,item,cache,dest,on_download=None):
                target=dest/kind/item['name'];target.parent.mkdir(parents=True,exist_ok=True);target.write_text('abc')
            with patch('idoly_story_index.game_archive.process_item',side_effect=fake_extract):
                versions=prepare_archives(root,stage,manifest,old,1)
            self.assertEqual(len(versions['versions']),5)
            with tarfile.open(root/'downloads'/versions['versions'][0]['filename']) as archive:
                info=json.load(archive.extractfile('increment.json'))
                self.assertEqual(info['removed'],['assetBundleList/deleted'])
                self.assertIn('resourceList/adv_unindexed.txt',info['changed'])
                self.assertIn('resourceList/adv_unindexed.txt',archive.getnames())
    def test_first_run_is_baseline_not_fake_historical_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);stage=root/'stage';stage.mkdir()
            value=prepare_archives(root,stage,{'revision':100,'assetBundleList':[],'resourceList':[]},None)
            self.assertEqual(value['versions'],[]);self.assertTrue(value['baseline_only'])


class PublicationTests(unittest.TestCase):
    def test_inventory_retains_only_requested_objects_across_pages(self):
        class S3:
            def get_paginator(self,operation):
                self.operation=operation;return self
            def paginate(self,**kwargs):
                self.prefix=kwargs['Prefix']
                return [{'Contents':[{'Key':'prefix/media/old/old.flac','Size':9},
                                     {'Key':'prefix/media/new/one.flac','Size':3}]},
                        {'Contents':[{'Key':'prefix/media/new/two.flac','Size':4}]}]
            def head_object(self,**kwargs):raise AssertionError('Per-file HEAD forbidden')
        s3=S3()
        result=inventory_for(s3,'bucket','prefix',{'media/new/one.flac':None,'media/new/two.flac':None})
        self.assertEqual(result,{'media/new/one.flac':3,'media/new/two.flac':4})
        self.assertEqual(s3.operation,'list_objects_v2')
        self.assertEqual(s3.prefix,'prefix/media/')

    def test_upload_checks_use_bulk_listings_without_head_requests(self):
        class S3:
            def __init__(self):self.objects={};self.listings=0;self.uploads=0
            def get_paginator(self,operation):
                self.assert_operation=operation;return self
            def paginate(self,**kwargs):
                self.listings+=1
                return [{'Contents':[{'Key':k,'Size':v} for k,v in self.objects.items() if k.startswith(kwargs['Prefix'])]}]
            def upload_file(self,path,bucket,key,**kwargs):
                self.objects[key]=Path(path).stat().st_size;self.uploads+=1
                kwargs['Callback'](self.objects[key])
            def head_object(self,**kwargs):raise AssertionError('Per-file HEAD forbidden')
        with tempfile.TemporaryDirectory() as temp:
            stage=self.fixture(temp);_,jobs=snapshot_plan(stage);s3=S3()
            upload_batch(s3,'bucket','prefix',jobs,'test',1)
            self.assertEqual(s3.uploads,len(jobs));self.assertEqual(s3.listings,4)
            upload_batch(s3,'bucket','prefix',jobs,'repeat',1)
            self.assertEqual(s3.uploads,len(jobs));self.assertEqual(s3.listings,6)

    def fixture(self,temp):
        stage=Path(temp)/'release';(stage/'web/data').mkdir(parents=True)
        (stage/'web/data/catalog.json').write_text('{}')
        (stage/'media/voice').mkdir(parents=True);(stage/'media/voice/voice.flac').write_bytes(b'fLaC-example')
        return stage
    def test_media_keys_reused_and_mapping_sharded(self):
        with tempfile.TemporaryDirectory() as temp:
            stage=self.fixture(temp);files,jobs=snapshot_plan(stage)
            voice=files['media/voice/voice.flac']
            sha=hashlib.sha256(b'fLaC-example').hexdigest()
            self.assertEqual(voice,f'media/{sha}/voice.flac')
            root=json.loads((stage/'file-map.json').read_text());self.assertFalse(root['files'])
            shard=hashlib.sha256(b'media/voice/voice.flac').hexdigest()[:2]
            self.assertEqual(json.loads((stage/'maps'/(shard+'.json')).read_text())['files']['media/voice/voice.flac'],voice)
    def test_failed_upload_never_switches_pointer(self):
        class S3:
            writes=[]
            def get_paginator(self,*args):return self
            def paginate(self,**kwargs):return []
            def put_object(self,**kwargs):self.writes.append(kwargs)
        with tempfile.TemporaryDirectory() as temp:
            stage=self.fixture(temp);s3=S3()
            with patch('idoly_story_index.publish.upload_batch',side_effect=RuntimeError('failed')):
                with self.assertRaises(RuntimeError):publish(s3,'bucket','prefix',stage,{'revision':1,'versions':[]},'old-etag',Path(temp))
            self.assertFalse(s3.writes)
    def test_pointer_written_last_with_etag(self):
        calls=[]
        class S3:
            def get_paginator(self,*args):return self
            def paginate(self,**kwargs):return []
            def put_object(self,**kwargs):calls.append(('pointer',kwargs))
        with tempfile.TemporaryDirectory() as temp:
            stage=self.fixture(temp)
            def batch(*args):calls.append(('batch',args[3]))
            with patch('idoly_story_index.publish.upload_batch',side_effect=batch):
                publish(S3(),'bucket','prefix',stage,{'revision':1,'versions':[]},'expected',Path(temp))
            self.assertEqual(calls[-1][0],'pointer');self.assertEqual(calls[-1][1]['IfMatch'],'expected')
            self.assertTrue(any('maps/' in key for _,value in calls[:-1] for key in value))


if __name__=='__main__':unittest.main()
