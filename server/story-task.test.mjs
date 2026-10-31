import test from 'node:test';
import assert from 'node:assert/strict';
import { storyTaskGroup } from './story-task.mjs';

function directory(nodes) {
  const stories = {};
  for (const node of Object.values(nodes)) for (const id of node.stories) stories[id] = { group:node.id, indexVisible:true };
  return {roots:['main','event','card','hbd'],nodes,stories};
}
const node = (id,parent,stories=[],children=[]) => ({id,parent,label:id,stories,children});

test('card groups use exact MasterDB membership rather than filename prefixes',()=>{
  const data=directory({card:node('card',null,[],['card:ski']),
    'card:ski':node('card:ski','card',[],['birthday','another']),
    birthday:node('birthday','card:ski',['adv_card_ski_54_01','adv_card_ski_54_02','adv_card_ski_54_03']),
    another:node('another','card:ski',['adv_card_ski_540_01'])});
  assert.deepEqual(storyTaskGroup(data,'adv_card_ski_54_01').scriptIds,
    ['adv_card_ski_54_01','adv_card_ski_54_02','adv_card_ski_54_03']);
});

test('event groups include other stories with different CSV prefixes and have one stable signature',()=>{
  const data=directory({event:node('event',null,[],['normal']),normal:node('normal','event',[],['after']),
    after:node('after','normal',['adv_main_04_15_01'],['after:other']),
    'after:other':node('after:other','after',['adv_event_2610_99_01','adv_event_2610_99_01_short'])});
  const primary=storyTaskGroup(data,'adv_main_04_15_01');
  assert.deepEqual(primary.scriptIds,['adv_event_2610_99_01','adv_main_04_15_01']);
  assert.deepEqual(storyTaskGroup(data,'adv_event_2610_99_01'),primary);
  data.nodes.after.stories.push('adv_main_04_15_02');data.stories.adv_main_04_15_02={group:'after',indexVisible:true};
  assert.notEqual(storyTaskGroup(data,'adv_main_04_15_01').sha,primary.sha);
});

test('main stories stay within the chapter and birthday stories within the character',()=>{
  const data=directory({main:node('main',null,[],['part']),part:node('part','main',[],['chapter1','chapter2']),
    chapter1:node('chapter1','part',['adv_main_02_01_01','adv_main_02_01_02']),
    chapter2:node('chapter2','part',['adv_main_02_02_01']),
    hbd:node('hbd',null,[],['hbd:ski','hbd:szk']),
    'hbd:ski':node('hbd:ski','hbd',[],['hbd:ski:2026','hbd:ski:player']),
    'hbd:ski:2026':node('hbd:ski:2026','hbd:ski',['adv_hbd_06_ski']),
    'hbd:ski:player':node('hbd:ski:player','hbd:ski',['adv_userhbd_01_ski']),
    'hbd:szk':node('hbd:szk','hbd',['adv_hbd_06_szk'])});
  assert.deepEqual(storyTaskGroup(data,'adv_main_02_01_01').scriptIds,['adv_main_02_01_01','adv_main_02_01_02']);
  assert.deepEqual(storyTaskGroup(data,'adv_hbd_06_ski').scriptIds,['adv_hbd_06_ski','adv_userhbd_01_ski']);
});

test('unmapped, hidden, oversized or corrupt groups fail closed',()=>{
  const data=directory({group:node('group','main',['adv_demo'])});
  data.stories.adv_demo.indexVisible=false;
  assert.throws(()=>storyTaskGroup(data,'adv_demo'),{status:404});
  data.stories.adv_demo.indexVisible=true;data.nodes.group.children=['group'];
  assert.throws(()=>storyTaskGroup(data,'adv_demo'),{status:503});
  data.nodes.group.children=[];data.nodes.group.stories.push(...Array.from({length:201},(_,i)=>'adv_demo_'+i));
  for (const id of data.nodes.group.stories) data.stories[id]={group:'group',indexVisible:true};
  assert.throws(()=>storyTaskGroup(data,'adv_demo'),{status:400});
  assert.throws(()=>storyTaskGroup(data,'adv_demo_short'),{status:400});
});
