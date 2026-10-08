import test from 'node:test';
import assert from 'node:assert/strict';
import { extractInfoFromCsvText } from './upstream/csv';
import { buildVoiceMap } from './voice-map';

const csv = 'id,name,text,trans\ninfo,adv_test.txt,hash,\n1:text:1,愛,原文一,\n2:text:1,優,原文二,\n译者,,,\n';
const clips = [{url:'/voice.flac',label:'語音'}];

test('voice mapping requires exact original row ID, speaker and text', () => {
  const source = extractInfoFromCsvText(csv);
  const map = buildVoiceMap(source,'hash',undefined,{lines:[
    {row_id:'1:text:1',text:'原文一',speaker:'愛',clips},
    {row_id:'2:text:1',text:'原文二',speaker:'愛',clips},
    {row_id:'2:text:1',text:'旧原文',speaker:'優',clips},
    {row_id:'missing',text:'原文二',speaker:'優',clips},
  ]});
  assert.deepEqual([...map.keys()],[0]);
  assert.equal(map.get(0)?.clips,clips);
  source.data[0].trans = '译文变化';
  assert.deepEqual(buildVoiceMap(source,'hash',undefined,{lines:[{row_id:'1:text:1',text:'原文一',speaker:'愛',clips}]}),map);
});
test('legacy record positions require a matching source hash and exclude metadata', () => {
  const source = extractInfoFromCsvText(csv);
  const voices = {source_sha256:'hash',lines:[
    {record_index:1,text:'hash',speaker:'adv_test.txt',clips},
    {record_index:2,text:'原文一',speaker:'愛',clips},
    {record_index:3,text:'原文二',speaker:'wrong',clips},
  ]};
  assert.deepEqual([...buildVoiceMap(source,'hash',voices).keys()],[0]);
  assert.equal(buildVoiceMap(source,'different',voices).size,0);
  assert.equal(buildVoiceMap(null,'hash',voices).size,0);
});
test('a refreshed source remaps voices by identity, and IDOLY clips take precedence', () => {
  const source = extractInfoFromCsvText(csv);
  const oldClips = [{url:'/old.flac',label:'old'}];
  const voices = {source_sha256:'hash',lines:[{record_index:2,text:'原文一',speaker:'愛',clips:oldClips}]};
  const idoly = {lines:[{row_id:'1:text:1',text:'原文一',speaker:'愛',clips}]};
  assert.equal(buildVoiceMap(source,'hash',voices,idoly).get(0)?.clips,clips);
  const refreshed = extractInfoFromCsvText(csv.replace('1:text:1,愛,原文一,','1:text:1,愛,新原文,'));
  assert.equal(buildVoiceMap(refreshed,'hash',voices,idoly).size,0);
});
