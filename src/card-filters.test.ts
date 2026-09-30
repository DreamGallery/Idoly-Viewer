import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultCardFilters, matchesCardFilters, type CardTraits} from './card-filters';

test('unknown cards stay in all, but cannot satisfy an explicit trait',()=>{
 assert.equal(matchesCardFilters(undefined,defaultCardFilters),true);
 assert.equal(matchesCardFilters(undefined,{...defaultCardFilters,attribute:'vocal'}),false);
 assert.equal(matchesCardFilters(undefined,{...defaultCardFilters,role:'scorer'}),false);
 assert.equal(matchesCardFilters(undefined,{...defaultCardFilters,spOnly:true}),false);
});
test('attribute, role, and SP combine independently',()=>{
 const card: CardTraits={...defaultCardFilters,attribute:'dance',role:'buffer',hasSp:true};
 assert.equal(matchesCardFilters(card,{...defaultCardFilters,attribute:'dance',role:'buffer',spOnly:true}),true);
 assert.equal(matchesCardFilters(card,{...defaultCardFilters,attribute:'vocal',role:'buffer',spOnly:true}),false);
 assert.equal(matchesCardFilters(card,{...defaultCardFilters,attribute:'dance',role:'scorer',spOnly:true}),false);
 assert.equal(matchesCardFilters({...card,hasSp:false},{...defaultCardFilters,attribute:'dance',role:'buffer',spOnly:true}),false);
});

test('evolution filter intersects other traits and excludes unknown cards',()=>{
 const filter={...defaultCardFilters,evolutionOnly:true};
 const card:CardTraits={attribute:'vocal',role:'scorer',hasSp:true,hasEvolution:true};
 assert.equal(matchesCardFilters(card,filter),true);
 assert.equal(matchesCardFilters({...card,hasEvolution:false},filter),false);
 assert.equal(matchesCardFilters(undefined,filter),false);
 assert.equal(matchesCardFilters(card,{...filter,attribute:'dance'}),false);
 assert.equal(matchesCardFilters(card,{...filter,spOnly:true}),true);
});
