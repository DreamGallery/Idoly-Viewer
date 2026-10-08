import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStorySearchIndex, filterStories } from './story-search';
import { defaultCardFilters } from './card-filters';
import type { Catalog, Story } from './idoly-types';
import type { Directory } from './StoryDirectory';

function fixture() {
  const story = (id: string, category: string, extra: Partial<Story> = {}): Story => ({
    id, category, path: category+'/'+id+'.csv', title: id, originalTitle: id, characters: ['ai','yu'],
    lines: 2, aiLines: 0, humanLines: 0, masterId: id, references: [], sourceHash: '', sourceFileHash: '', ...extra,
  });
  const stories = [story('adv_card_ai_01_01','card',{title:'星空',translationStatus:'human'}),
    story('adv_card_yu_02_01','card',{translationStatus:'completed'}),
    story('adv_userhbd_01_ai','hbd'), story('adv_love_2501_01','love'),
    story('adv_main_01_01_00','main',{references:[{label:'Tokyo',table:'StoryPart',episode:0}]}),
    story('missing','card')];
  const catalog: Catalog = { stories, groups: [], provenance: {revision:'1',sourceCommit:'',translationCommit:'',validationWarnings:0,translationMismatches:0},
    characters: ['ai','yu'].map(id => ({id,name:id,originalName:id,enName:id,group:id+'-group',color:'',image:''})) };
  const node = (id: string, parent: string | null = null): Directory['nodes'][string] => ({id,label:id,parent,children:[],stories:[],count:0,images:[]});
  const directory: Directory = {roots:[],nodes:{chapter:node('Chapter One','main'),main:node('主线')},stories:{}};
  for (const item of stories) directory.stories[item.id] = {group:'chapter',images:[],voiceLines:0,indexVisible:item.id!=='missing'};
  directory.nodes.card = {...node('card'),cardTraits:{attribute:'vocal',role:'scorer',hasSp:true,hasEvolution:true}};
  directory.stories[stories[0].id].group = 'card';
  return buildStorySearchIndex(catalog,directory);
}
const filters = {category:'card',character:'',group:'all',status:'all',query:'',cardFilters:defaultCardFilters};
const ids = (stories: Story[]) => stories.map(story => story.id);

test('visible stories retain catalog order; special events share the event category', () => {
  const index = fixture();
  assert.deepEqual(ids(filterStories(index,filters)), ['adv_card_ai_01_01','adv_card_yu_02_01']);
  assert.deepEqual(ids(filterStories(index,{...filters,category:'event'})), ['adv_love_2501_01']);
  assert.deepEqual(filterStories(index,{...filters,category:'unavailable'}), []);
  assert.equal(buildStorySearchIndex(null,null).size,0);
});
test('character-owned categories filter by owner; other categories filter by cast', () => {
  const index = fixture();
  assert.deepEqual(ids(filterStories(index,{...filters,character:'yu'})), ['adv_card_yu_02_01']);
  assert.deepEqual(ids(filterStories(index,{...filters,group:'ai-group'})), ['adv_card_ai_01_01']);
  assert.deepEqual(ids(filterStories(index,{...filters,category:'hbd',character:'ai'})), ['adv_userhbd_01_ai']);
  assert.deepEqual(ids(filterStories(index,{...filters,category:'main',character:'yu',group:'ai-group'})), ['adv_main_01_01_00']);
});
test('search includes ancestor labels and references and combines with card/status filters', () => {
  const index = fixture();
  assert.equal(filterStories(index,{...filters,category:'main',query:'chapter one 主线'}).length,1);
  assert.equal(filterStories(index,{...filters,category:'main',query:'TOKYO'}).length,1);
  const selected = {...filters,query:'星空',status:'human',cardFilters:{...defaultCardFilters,spOnly:true,evolutionOnly:true}};
  assert.deepEqual(ids(filterStories(index,selected)), ['adv_card_ai_01_01']);
  assert.deepEqual(filterStories(index,{...selected,status:'completed'}), []);
  assert.deepEqual(filterStories(index,{...selected,cardFilters:{...selected.cardFilters,attribute:'dance'}}), []);
});
