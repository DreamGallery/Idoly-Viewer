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
 const filter={...defaultCardFilters,special:'evolution' as const};
 const card:CardTraits={attribute:'vocal',role:'scorer',hasSp:true,hasEvolution:true};
 assert.equal(matchesCardFilters(card,filter),true);
 assert.equal(matchesCardFilters({...card,hasEvolution:false},filter),false);
 assert.equal(matchesCardFilters(undefined,filter),false);
 assert.equal(matchesCardFilters(card,{...filter,attribute:'dance'}),false);
 assert.equal(matchesCardFilters(card,{...filter,spOnly:true}),true);
});

test('birthday and evolution are separate special choices and combine with other traits',()=>{
 const birthday:CardTraits={attribute:'visual',role:'buffer',hasSp:true,isBirthday:true,hasEvolution:false};
 const evolution:CardTraits={...birthday,isBirthday:false,hasEvolution:true};
 const filter={...defaultCardFilters,special:'birthday' as const};
 assert.equal(matchesCardFilters(birthday,filter),true);
 assert.equal(matchesCardFilters(evolution,filter),false);
 assert.equal(matchesCardFilters(undefined,filter),false);
 assert.equal(matchesCardFilters(birthday,{...filter,attribute:'visual',spOnly:true}),true);
 assert.equal(matchesCardFilters(birthday,{...filter,role:'scorer'}),false);
 assert.equal(matchesCardFilters(birthday,{...filter,special:'evolution'}),false);
 assert.equal(matchesCardFilters(evolution,{...filter,special:'evolution'}),true);
 assert.equal(matchesCardFilters(birthday,defaultCardFilters),true);
 assert.equal(matchesCardFilters(evolution,defaultCardFilters),true);
});
