import json
from pathlib import Path
import unittest
from idoly_story_index.build import voice_links, timing, event_sort_time, birthday_group_label
from idoly_story_index.card_traits import card_traits
from idoly_story_index.translation_status import translation_status
from idoly_story_index.exclusions import confirmed_exclusions
from idoly_story_index.index_visibility import is_indexed_story

ROOT=Path(__file__).resolve().parents[1]

class BirthdayLabelTest(unittest.TestCase):
    def test_same_sequence_can_mean_different_years(self):
        self.assertEqual(birthday_group_label('hbd','04','長瀬琴乃 誕生日2023'),'2023年')
        self.assertEqual(birthday_group_label('hbd','04','長瀬麻奈 誕生日2024'),'2024年')

    def test_unknown_year_and_player_birthday_are_not_invented(self):
        self.assertEqual(birthday_group_label('hbd','06',None),'偶像生日 · 06')
        self.assertEqual(birthday_group_label('userhbd','01',None),'玩家生日')

class CardTraitsTest(unittest.TestCase):
    def test_sp_skill_does_not_replace_support_role(self):
        card={'type':3,'vocalRatioPermil':430,'danceRatioPermil':300,'visualRatioPermil':270,'skillId1':'sp','skillId2':'a'}
        self.assertEqual(card_traits(card,{'sp':{'categoryType':1},'a':{'categoryType':2}}),{'attribute':'vocal','role':'supporter','hasSp':True})

    def test_tied_parameters_and_missing_skill_are_not_guessed(self):
        card={'type':2,'vocalRatioPermil':400,'danceRatioPermil':400,'visualRatioPermil':200,'skillId1':'missing'}
        self.assertEqual(card_traits(card,{}),{'attribute':None,'role':'buffer','hasSp':False})

class IndexVisibilityTest(unittest.TestCase):
    def test_main_prologue_requires_a_resolved_master_chapter(self):
        story={'id':'adv_main_02_01_00','category':'main','masterId':None}
        nodes={'chapter':{'parent':'part'},'part':{'parent':'main'},'main:unmapped':{'parent':'main'}}
        self.assertTrue(is_indexed_story(story,'chapter',nodes))
        self.assertFalse(is_indexed_story(story,'main:unmapped',nodes))

    def test_resolved_event_supplement_survives_missing_story_row(self):
        story={'id':'adv_event_2506_02_ai','category':'event','masterId':None}
        nodes={'named:other':{'parent':'named'},'named':{'parent':'event:normal'},'unknown':{'parent':'event:normal'}}
        self.assertTrue(is_indexed_story(story,'named:other',nodes))
        self.assertFalse(is_indexed_story(story,'unknown',nodes))
        self.assertFalse(is_indexed_story(story,'missing:other',nodes))

class TranslationStatusTest(unittest.TestCase):
    def test_ai_only_remains_untranslated(self):
        self.assertEqual(translation_status([{'text':'original','ai':'译文'}]),'empty')

    def test_human_and_partial_review_remain_pending_review(self):
        self.assertEqual(translation_status([{'text':'one','human':'译文'}]),'human')
        self.assertEqual(translation_status([{'text':'one','reviewed':'译文'},{'text':'two','reviewed':' '}]),'human')

    def test_only_complete_review_is_completed(self):
        self.assertEqual(translation_status([{'text':'one','reviewed':'译文'},{'text':'','reviewed':''}]),'completed')
        self.assertEqual(translation_status([]),'empty')
        self.assertEqual(translation_status([{'text':'one','reviewed':''}]),'empty')

class VoiceLinksTest(unittest.TestCase):
    def test_continuous_cue_and_other_actor(self):
        script='\n'.join([
            '[message text=one name=愛 thumbnial=img_chr_adv_ai-00 clip=\\{"_startTime":1,"_duration":2\\}]',
            '[message text=two name=愛 thumbnial=img_chr_adv_ai-00 clip=\\{"_startTime":3,"_duration":2\\}]',
            '[message text=other name=優 thumbnial=img_chr_adv_yu-00 clip=\\{"_startTime":3,"_duration":2\\}]',
            '[voice voice=sud_vo_adv_test-ai001 actorId=ai clip=\\{"_startTime":1,"_duration":4\\}]',
            '[message text=later name=愛 thumbnial=img_chr_adv_ai-00 clip=\\{"_startTime":6,"_duration":2\\}]',
        ])
        rows=[{'id':f'{i}:text:1','text':text,'name':name} for i,text,name in [(1,'one','愛'),(2,'two','愛'),(3,'other','優'),(5,'later','愛')]]
        links=voice_links(script,rows,{'sud_vo_adv_test':{}})
        self.assertEqual([x['row_id'] for x in links],['1:text:1','2:text:1'])
        self.assertEqual(links[0]['clips'],links[1]['clips'])
        self.assertEqual(voice_links(script,rows,{}),[])

    def test_bad_timeline_is_not_guessed(self):
        self.assertIsNone(timing('[voice voice=test]'))
        self.assertIsNone(timing('[voice clip=broken]'))

    def test_new_cue_replaces_overlapping_tail_for_same_actor(self):
        # Mirrors adv_bond_ai_01_05 row 25: ai001 ends at 13.789s,
        # but ai002 has already started at 13.6s.
        script='\n'.join([
            '[message text=new name=愛 thumbnial=img_chr_adv_ai-00 clip={"_startTime":13.6,"_duration":2}]',
            '[message text=continued name=愛 thumbnial=img_chr_adv_ai-00 clip={"_startTime":15,"_duration":1}]',
            '[voice voice=sud_vo_adv_test-ai002 actorId=ai clip={"_startTime":13.6,"_duration":4}]',
            '[voice voice=sud_vo_adv_test-ai001 actorId=ai clip={"_startTime":0.8,"_duration":20}]',
            '[message text=after name=愛 thumbnial=img_chr_adv_ai-00 clip={"_startTime":19,"_duration":1}]',
        ])
        rows=[{'id':f'{i}:text:1','text':text,'name':'愛'} for i,text in [(1,'new'),(2,'continued'),(5,'after')]]
        links=voice_links(script,rows,{'sud_vo_adv_test':{}})
        self.assertEqual([line['row_id'] for line in links],['1:text:1','2:text:1'])
        for line in links:
            self.assertEqual([clip['asset'] for clip in line['clips']],['sud_vo_adv_test-ai002'])

    def test_same_time_chorus_keeps_each_actor(self):
        script='\n'.join([
            '[message text=hello name=一同 clip={"_startTime":10,"_duration":2}]',
            '[voice voice=sud_vo_adv_test-ai001 actorId=ai clip={"_startTime":10,"_duration":2}]',
            '[voice voice=sud_vo_adv_test-yu001 actorId=yu clip={"_startTime":10,"_duration":2}]',
        ])
        links=voice_links(script,[{'id':'1:text:1','text':'hello','name':'一同'}],{'sud_vo_adv_test':{}})
        self.assertEqual([clip['asset'] for clip in links[0]['clips']],['sud_vo_adv_test-ai001','sud_vo_adv_test-yu001'])

class DirectorySnapshotTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory=json.loads((ROOT/'public/data/directory.json').read_text())
        cls.catalog=json.loads((ROOT/'public/data/catalog.json').read_text())
        cls.nodes=cls.directory['nodes']

    def ancestor(self,key):
        while self.nodes[key]['parent']:
            key=self.nodes[key]['parent']
        return key

    def test_every_csv_exactly_once_and_correct_category(self):
        memberships=[sid for n in self.nodes.values() for sid in n['stories']]
        self.assertEqual(len(memberships),len(set(memberships)))
        self.assertEqual(set(memberships),{s['id'] for s in self.catalog['stories']})
        for s in self.catalog['stories']:
            group=self.directory['stories'][s['id']]['group']
            self.assertEqual(self.ancestor(group),'event' if s['category']=='love' else s['category'])

    def test_master_storypart_aliases_keep_primary_chapters(self):
        master=ROOT.parent/'Idoly-localify/.analysis/master-fetch-full'
        for part in json.loads((master/'StoryPart.json').read_text()):
            for chapter in part['chapters']:
                expected=part['id']+':'+str(chapter['chapter'])+':'+str(chapter.get('route',0))
                for ep in chapter['episodes']:
                    sid='adv_'+ep['assetId']
                    if sid in self.directory['stories']:
                        self.assertEqual(self.directory['stories'][sid]['group'],expected,sid)

    def test_chronology_uses_card_release_and_original_event_month(self):
        cards=json.loads((ROOT.parent/'Idoly-localify/.analysis/master-fetch-full/Card.json').read_text())
        for card in cards:
            if card['id'] in self.nodes:
                self.assertEqual(self.nodes[card['id']]['sortTime'],int(card['releaseDate']))
        # This 2022 event was reissued in 2023; keep its original story month.
        self.assertEqual(self.nodes['ex-st-part-limited-23-0528-01']['sortTime'],event_sort_time(['adv_event_2206_01_01']))
        for parent in ['event:normal','event:love']:
            for key in self.nodes[parent]['children']:
                if key not in ['event:cmn','event:excursion']:
                    self.assertIsInstance(self.nodes[key]['sortTime'],int,key)
        self.assertIsNone(self.nodes['event:cmn']['sortTime'])
        self.assertIsNone(self.nodes['event:excursion']['sortTime'])

    def test_short_csv_is_excluded(self):
        self.assertFalse(any(sid.endswith('_short') for sid in self.directory['stories']))
        self.assertFalse(any(s['id'].endswith('_short') for s in self.catalog['stories']))

    def test_confirmed_duplicate_excluded_but_split_parts_retained(self):
        excluded=confirmed_exclusions(ROOT.parent/'Hoshimi-Adv')
        ids={s['id'] for s in self.catalog['stories']}
        self.assertTrue(excluded.isdisjoint(ids))
        self.assertTrue(excluded.isdisjoint(self.directory['stories']))
        for sid in ['adv_event_2410_01_05_01','adv_event_2410_01_05_02']:
            self.assertIn(sid,ids)
        self.assertNotIn('adv_event_2410_01',self.nodes)
        for sid in excluded:
            for folder in ['public/data/stories','public/data/media','public/catalog/chapters']:
                self.assertFalse((ROOT/folder/(sid+'.json')).exists())

    def test_same_month_supplements_fold_under_named_event(self):
        expected={
            '2109':'st-eve-2109-backside',
            '2111':'st-eve-2111-backside',
            '2208':'ex-st-part-limited-23-0528-02',
            '2302':'ex-st-part-limited-23-0611-06',
            '2305':'st-eve-2305-race',
            '2309':'st-eve-2309-backside',
            '2506':'st-eve-2507-race',
        }
        supplements=[]
        for month,parent in expected.items():
            child=self.nodes[parent+':other']
            self.assertEqual(child['label'],'其他剧情')
            self.assertEqual(child['parent'],parent)
            self.assertTrue(child['stories'])
            for sid in child['stories']:
                self.assertTrue(sid.startswith('adv_event_'+month+'_02_'))
                self.assertEqual(self.directory['stories'][sid]['group'],child['id'])
                self.assertTrue(self.directory['stories'][sid]['indexVisible'])
            supplements.extend(child['stories'])
            self.assertNotIn('adv_event_'+month+'_02',self.nodes)
        self.assertEqual(len(supplements),53)
        updates=json.loads((ROOT/'public/data/updates.json').read_text())
        update_by_id={row['script_id']:row for row in updates['items']}
        self.assertTrue(all(not update_by_id[sid]['pending'] for sid in supplements))
        self.assertEqual(self.nodes['adv_event_2505_01']['parent'],'event:normal')

    def test_unmapped_card_cover_uses_explicit_reference_from_later_chapter(self):
        group=self.nodes['adv_card_ski_54']
        asset='img_card_full_1_ski-05-birt-03'
        self.assertEqual(group['images'][0]['asset'],asset)
        self.assertEqual(group['coverSource']['scripts'],['adv_card_ski_54_03'])
        self.assertIsNone(next(s for s in self.catalog['stories'] if s['id']=='adv_card_ski_54_01')['masterId'])
        updates=json.loads((ROOT/'public/data/updates.json').read_text())
        rows=[row for row in updates['items'] if row['group_id']==group['id']]
        self.assertEqual(len(rows),3)
        self.assertTrue(all(row['pending'] and row['images'][0]['asset']==asset for row in rows))

    def test_tokyo_prologue_stays_first_in_its_resolved_chapter(self):
        sid='adv_main_02_01_00'
        entry=self.directory['stories'][sid]
        self.assertTrue(entry['indexVisible'])
        self.assertEqual(entry['group'],'st-part-main-01:1:1')
        self.assertEqual(self.nodes[entry['group']]['stories'][0],sid)
        updates=json.loads((ROOT/'public/data/updates.json').read_text())
        self.assertFalse(next(row for row in updates['items'] if row['script_id']==sid)['pending'])

    def test_counts_and_no_dangling_nodes(self):
        for n in self.nodes.values():
            self.assertEqual(n['count'],len(n['stories'])+sum(self.nodes[k]['count'] for k in n['children']))
            self.assertTrue(n['count']>0)
        self.assertEqual(sum(self.nodes[k]['count'] for k in self.directory['roots']),2663)
        self.assertEqual(self.nodes['event:normal']['count'],576)
        self.assertEqual(self.nodes['event:love']['count'],68)

    def test_evolving_cards_keep_both_forms_and_movies_in_one_group(self):
        master=ROOT.parent/'Idoly-localify/.analysis/master-fetch-full'
        evolutions=json.loads((master/'CardEvolution.json').read_text())
        cards={c['id']:c for c in json.loads((master/'Card.json').read_text())}
        plan=json.loads((ROOT/'public/data/media-plan.json').read_text())
        for row in evolutions:
            card=cards[row['cardId']]
            node=self.nodes.get(card['id'])
            if not node:
                continue
            self.assertTrue(node['cardTraits']['hasEvolution'])
            self.assertEqual([image['label'] for image in node['images']],
                             [node['label']+'·觉醒前',node['label']+'·觉醒后'])
            self.assertEqual(len(node['videos']),2)
            for video,kind,stage in zip(node['videos'],['full','evolution'],[1,2]):
                name='mov_card_'+kind+'_'+card['assetId']+'_1080p.mp4'
                self.assertEqual(video['url'],'/api/media/video/'+name)
                self.assertEqual(video['poster'],node['images'][stage-1]['url'])
                self.assertEqual(video['label'],node['images'][stage-1]['label'])
                self.assertIn(name,plan['assets'])
                self.assertEqual(plan['videos'][name.removesuffix('.mp4')],name)
        evolving_ids={row['cardId'] for row in evolutions}
        for key,node in self.nodes.items():
            if key not in evolving_ids:
                self.assertFalse(any('·觉醒' in image['label'] for image in node['images']))

    def test_story_part_covers_use_category_specific_game_frame(self):
        for category in ['main','group']:
            for key in self.nodes[category]['children']:
                image=self.nodes[key]['images'][0]
                prefix='img_story_parttop_' if category=='main' else 'img_story_partthumb_'
                self.assertTrue(image['asset'].startswith(prefix))
                self.assertEqual(image['aspect_ratio'],4/3 if category=='main' else 1)

    def test_event_covers_use_available_landscape_banner(self):
        manifest=json.loads((ROOT.parent/'HoshimiToolkit/cache/OctoManifest.json').read_text())
        assets={item['name'] for item in manifest['assetBundleList']}
        events=json.loads((ROOT.parent/'Idoly-localify/.analysis/master-fetch-full/EventStory.json').read_text())
        for event in events:
            node=self.nodes.get(event['id'])
            banner='img_story_event_banner_'+event['assetId']
            if node and banner in assets:
                self.assertEqual(node['images'][0]['asset'],banner,event['id'])
        # Vertical story-top images must never inherit a landscape 2:1 ratio.
        for node in self.nodes.values():
            for image in node['images']:
                if image.get('asset','').startswith('img_story_top_event'):
                    self.assertIsNone(image.get('aspect_ratio'))

    def test_voice_rows_match_current_script_snapshot(self):
        # Full-corpus alignment, not a positional sample: edited translations do
        # not affect these original row IDs/text/speakers.
        for sid in self.directory['stories']:
            media=json.loads((ROOT/'public/data/media'/(sid+'.json')).read_text())
            story=json.loads((ROOT/'public/data/stories'/(sid+'.json')).read_text())
            original={r['id']:(r['text'],r['name']) for r in story['rows']}
            self.assertEqual(media['source_script_sha256'],story['sourceHash'])
            for line in media['voices']['lines']:
                self.assertEqual((line['text'],line['speaker']),original[line['row_id']])

if __name__=='__main__':unittest.main()
