import { Users } from 'lucide-react';
import { attributeOptions, roleOptions, defaultCardFilters, type CardFilters } from './card-filters';
import type { Catalog } from './idoly-types';
import type { Directory } from './StoryDirectory';

const colorGroupIcons = new Set(['character_group_1','character_group_2','character_group_3','character_group_4','character_group_6']);

export default function CharacterFilter({ data, directory, group, character, onGroupChange, onCharacterChange, cardFilters, onCardFiltersChange }: {
 data: Catalog; directory: Directory | null; group: string; character: string;
 cardFilters: CardFilters; onCardFiltersChange: (filters: CardFilters) => void;
 onGroupChange: (id: string) => void; onCharacterChange: (id: string) => void;
}) {
 const indexedCards = new Set(data.stories.filter(story=>story.category==='card'&&story.masterId).map(story=>directory?.stories[story.id]?.group));
 const available = data.characters.filter(c => directory?.nodes['card:'+c.id]?.children.some(id=>indexedCards.has(id)));
 const characters = available.filter(c => group === 'all' || c.group === group);
 const active=cardFilters.attribute!=='all'||cardFilters.role!=='all'||cardFilters.spOnly||cardFilters.evolutionOnly;
 return <section className="card-character-filter" aria-label="卡牌剧情角色筛选">
  <div className="character-group-options" role="group" aria-label="筛选组合">
   <button aria-pressed={group==='all'} onClick={()=>onGroupChange('all')}>全部组合</button>
   {data.groups.filter(g=>available.some(c=>c.group===g.id)).map(g=><button key={g.id} className="character-group-logo" aria-label={g.name} aria-pressed={group===g.id} onClick={()=>onGroupChange(g.id)}>{colorGroupIcons.has(g.id)?<img src={'/images/groups/color/'+g.id+'.png?v=1055'} alt=""/>:<span aria-hidden="true" style={{backgroundColor:/^[0-9a-f]{6}$/i.test(g.color)?'#'+g.color:undefined,maskImage:`url(/images/groups/${g.id}.png)`,WebkitMaskImage:`url(/images/groups/${g.id}.png)`}}/>}</button>)}
  </div>
  <div className="chibi-character-options" role="group" aria-label="筛选角色">
   <button className="chibi-character" aria-pressed={!character} onClick={()=>onCharacterChange('')}><span className="chibi-avatar chibi-all"><Users size={27}/></span><span>全部角色</span></button>
   {characters.map(c=><button key={c.id} className="chibi-character" aria-pressed={character===c.id} onClick={()=>onCharacterChange(c.id)}>
    <span className="chibi-avatar"><img src={'/images/characters/chibi/'+c.id+'.png'} alt="" loading="lazy"/></span>
    <span>{c.name}</span>
   </button>)}
  </div>
  <div className="card-trait-filters" role="group" aria-label="卡牌花色与类型筛选">
   <div className="card-trait-options" role="group" aria-label="花色">
    <span className="card-trait-label">花色</span>
    {attributeOptions.filter(([key])=>key!=='all').map(([key,label])=><button key={key} className={'card-trait-icon trait-'+key} aria-label={label} aria-pressed={cardFilters.attribute===key} onClick={()=>onCardFiltersChange({...cardFilters,attribute:cardFilters.attribute===key?'all':key})}><GameFilterIcon name={'parameter_'+key}/></button>)}
   </div>
   <div className="card-trait-options" role="group" aria-label="类型">
    <span className="card-trait-label">类型</span>
    {roleOptions.filter(([key])=>key!=='all').map(([key,label])=><button key={key} className={'card-trait-icon role-'+key} aria-label={label} aria-pressed={cardFilters.role===key} onClick={()=>onCardFiltersChange({...cardFilters,role:cardFilters.role===key?'all':key})}><img className="game-filter-image" src={'/images/card-filters/icon_'+key+'_thumbnail.png'} alt=""/></button>)}
   </div>
   <button className="card-trait-icon card-sp-filter" aria-label="含 SP 技能" aria-pressed={cardFilters.spOnly} onClick={()=>onCardFiltersChange({...cardFilters,spOnly:!cardFilters.spOnly})}><GameFilterIcon name="sp"/></button>
   <button className="card-trait-icon" aria-label="可觉醒卡牌" aria-pressed={cardFilters.evolutionOnly} onClick={()=>onCardFiltersChange({...cardFilters,evolutionOnly:!cardFilters.evolutionOnly})}><img className="game-filter-image" src="/images/card-filters/icon_after_evolution.png" alt=""/></button>
   {active&&<button className="card-trait-reset" onClick={()=>onCardFiltersChange(defaultCardFilters)}>重置卡牌筛选</button>}
  </div>
 </section>;
}

function GameFilterIcon({name}:{name:string}) {
 const url=`url(/images/card-filters/icon_${name}.png)`;
 return <span className="game-filter-icon" aria-hidden="true" style={{maskImage:url,WebkitMaskImage:url}}/>;
}
