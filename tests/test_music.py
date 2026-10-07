"""Cover resolution follows bundle references, including duplicate texture names."""
from types import SimpleNamespace
import unittest
from idoly_story_index.music import select_cover


def texture(name, marker):
    value = SimpleNamespace(m_Name=name, marker=marker)
    return SimpleNamespace(type=SimpleNamespace(name='Texture2D'), read=lambda: value)


class IndexedContainer:
    """UnityPy's mapping wrapper need not expose dict.get."""
    def __init__(self, entries):
        self.entries = entries

    def __getitem__(self, name):
        return self.entries[name]


class MusicCoverTests(unittest.TestCase):
    def test_duplicate_name_uses_declared_asset_not_object_order(self):
        first, declared = texture('jacket', 'first'), texture('jacket', 'declared')
        for objects in ([first, declared], [declared, first]):
            env = SimpleNamespace(container=IndexedContainer({'jacket': declared}), objects=objects)
            self.assertEqual(select_cover(env, 'jacket').marker, 'declared')

    def test_unique_exact_texture_without_container(self):
        env = SimpleNamespace(container=IndexedContainer({}), objects=[texture('unrelated', 'other'), texture('jacket', 'exact')])
        self.assertEqual(select_cover(env, 'jacket').marker, 'exact')

    def test_ambiguous_unbound_textures_are_not_guessed(self):
        env = SimpleNamespace(container=IndexedContainer({}), objects=[texture('jacket', 'a'), texture('jacket', 'b')])
        with self.assertRaisesRegex(ValueError, 'without a bundle reference'):
            select_cover(env, 'jacket')




class MusicIndexTests(unittest.TestCase):
    def fixture(self):
        from idoly_story_index.music_index import music_index
        rows=[{'id':'music-hsm-001','assetId':'hsm-001','name':'IDOLY PRIDE','singer':'Original','order':1},
              {'id':'duplicate','assetId':'hsm-001','name':'Duplicate','singer':'Other','order':2},
              {'id':'missing','assetId':'missing','name':'Missing cover','singer':'Other','order':3}]
        assets=[{'name':n,'md5':'a'*32,'size':1} for n in ['sud_music_short_hsm-001','img_music_jacket_hsm-001','sud_music_short_missing']]
        return music_index, rows, {'revision':1066,'urlFormat':'https://cdn.invalid/{o}','assetBundleList':assets}

    def test_published_catalog_uses_media_routes_and_no_private_manifest(self):
        build,rows,manifest=self.fixture()
        catalog,plan=build(manifest,rows,{'music-hsm-001':{'singer':'星见Production'}})
        self.assertEqual(len(catalog['tracks']),1)
        track=catalog['tracks'][0]
        self.assertEqual(track['artist'],'星见Production')
        self.assertEqual(track['audio'],'/api/media/voice/sud_music_short_hsm-001.flac')
        self.assertEqual(track['cover'],'/api/media/image/img_music_jacket_hsm-001.webp')
        self.assertNotIn('urlFormat',catalog)
        self.assertEqual(plan['voices'],{'sud_music_short_hsm-001':'sud_music_short_hsm-001'})
        manifest['assetBundleList'][1]['state']=4
        self.assertEqual(build(manifest,rows)[0]['tracks'],[])

    def test_docker_music_merges_existing_media_plan(self):
        import tempfile
        from pathlib import Path
        from idoly_story_index.build import save,load
        from idoly_story_index.runtime import add_music_snapshot
        _,rows,manifest=self.fixture()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);stage=root/'stage';master=root/'master';translations=root/'translations'
            save(master/'Music.json',rows)
            save(stage/'web/data/media-plan.json',{'assets':{'existing':{}},'images':['existing'],'voices':{'dialogue':'voicebank'},'videos':{}})
            add_music_snapshot(stage,master,translations,manifest)
            plan=load(stage/'web/data/media-plan.json')
            self.assertIn('existing',plan['assets']);self.assertEqual(plan['voices']['dialogue'],'voicebank')
            self.assertIn('img_music_jacket_hsm-001',plan['images'])
            self.assertEqual(len(load(stage/'web/data/music.json')['tracks']),1)

if __name__ == '__main__':
    unittest.main()
