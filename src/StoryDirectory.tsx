import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, BookOpen } from 'lucide-react';
import { storyTranslationStatus, translationStatusLabels } from './translation-status';
import CardPreview, { type CardVideo } from './CardPreview';
import type { CardTraits } from './card-filters';
import type { Catalog, Story } from './idoly-types';
import { isTextOnlyStoryGroup } from './story-presentation';
import ListPagination from './ListPagination';

export type SortOrder = 'default' | 'newest' | 'oldest';
export type MediaImage = { url: string; label: string; asset?: string; aspect_ratio?: number };
type DirectoryNode = { id: string; label: string; parent: string | null; children: string[]; stories: string[]; count: number; sortTime?: number | null; cardTraits?: CardTraits; images: MediaImage[]; videos?: CardVideo[]; portraitCover?: boolean };
export type Directory = { roots: string[]; nodes: Record<string, DirectoryNode>; stories: Record<string, {group:string;images:MediaImage[];voiceLines:number;indexVisible:boolean}> };
const cardPageSize = 24;

export default function StoryDirectory({ data, directory, filtered, category, openStory, searchKey, owner, sortOrder }: { data: Catalog; directory: Directory; filtered: Story[]; category: string; openStory: (id:string)=>void; searchKey: string; owner?: string; sortOrder: SortOrder }) {
 const [expanded,setExpanded]=useState<Set<string>>(new Set());
 const [eventType,setEventType]=useState('normal');
 const [page,setPage]=useState(1);
 useEffect(()=>setPage(1),[category,owner,sortOrder,searchKey,filtered,directory]);
 const canSortByTime=category==='card'||category==='event';
 useEffect(()=>{setExpanded(new Set(searchKey?Object.keys(directory.nodes):[]))},[category,searchKey,directory]);
 const stories=useMemo(()=>new Map(data.stories.map(s=>[s.id,s])),[data]);
 const matched=useMemo(()=>new Set(filtered.map(s=>s.id)),[filtered]);
 const counts=useMemo(()=>{
  const result:Record<string,number>={};
  const visit=(id:string):number=>{const n=directory.nodes[id];return result[id]=n.stories.filter(s=>matched.has(s)).length+n.children.reduce((sum,k)=>sum+visit(k),0)};
  directory.roots.forEach(visit);return result;
 },[directory,matched]);
 const toggle=(id:string)=>setExpanded(previous=>{const next=new Set(previous);if(next.has(id))next.delete(id);else next.add(id);return next});
 let roots=category==='event'?directory.nodes['event:'+eventType]?.children||[]:directory.nodes[category]?.children||[];
 if(category==='card')roots=owner?directory.nodes['card:'+owner]?.children||[]:roots.flatMap(id=>directory.nodes[id].children);
 if(owner&&category==='hbd')roots=directory.nodes['hbd:'+owner]?.children||[];
 roots=roots.filter(id=>counts[id]);
 if(canSortByTime&&sortOrder!=='default')roots.sort((a,b)=>{
  const left=directory.nodes[a].sortTime,right=directory.nodes[b].sortTime;
  if(left==null)return right==null?0:1;
  if(right==null)return -1;
  return sortOrder==='newest'?right-left:left-right;
 });
 const pages=category==='card'?Math.max(1,Math.ceil(roots.length/cardPageSize)):1;
 const currentPage=Math.min(page,pages);
 const visibleRoots=category==='card'?roots.slice((currentPage-1)*cardPageSize,currentPage*cardPageSize):roots;
 function renderNode(id:string,depth=0):React.ReactNode {
  const n=directory.nodes[id];if(!counts[id])return null;
  const isOpen=expanded.has(id);
  const showCover=depth===0&&!isTextOnlyStoryGroup(id);
  return <section key={id} className={`directory-group depth-${Math.min(depth,2)} ${isOpen?'is-expanded':''}`}>
   {showCover&&n.images.length>0&&<CardPreview images={n.images} videos={n.videos} title={n.label} compact portrait={n.portraitCover} zoomable={!['main','group','event'].includes(category)}/>}
   {showCover&&category==='event'&&n.images.length===0&&<div className="event-cover-placeholder" aria-hidden="true"><BookOpen size={36} strokeWidth={1.25}/></div>}
   <div className="directory-group-heading">
    <button className="directory-toggle" aria-expanded={isOpen} aria-controls={'group-'+id} onClick={()=>toggle(id)}>
     <span className="directory-chevron">{isOpen?<ChevronDown size={18}/>:<ChevronRight size={18}/>}</span>

     <span className="directory-group-label">{depth===0&&<span className="directory-kicker">{category==='card'&&n.parent?directory.nodes[n.parent]?.label:directory.nodes[category]?.label}</span>}<strong>{n.label}</strong></span>
    </button>
   </div>
   {isOpen&&<div id={'group-'+id} className="directory-group-body">
    {n.children.filter(k=>!k.endsWith(':other')).map(k=>renderNode(k,depth+1))}
    {n.stories.filter(sid=>matched.has(sid)).map((sid,index)=>{
     const s=stories.get(sid)!;
     const isPlayerBirthday=/^adv_userhbd_\d+_[a-z]+$/.test(sid);
     const translationStatus=storyTranslationStatus(s);
     return <button className="directory-story" key={sid} onClick={()=>openStory(sid)}>
      {!isPlayerBirthday&&<span className="directory-story-number">{String(index+1).padStart(2,'0')}</span>}
      <span className="directory-story-title"><strong>{s.title}</strong>{!isPlayerBirthday&&<small lang="ja">{s.originalTitle===s.title?s.id:s.originalTitle}</small>}</span>
      <span className="directory-story-meta"><span className={'status-tag '+translationStatus}>{translationStatusLabels[translationStatus]}</span><BookOpen size={16}/></span>
     </button>
    })}
    {n.children.filter(k=>k.endsWith(':other')).map(k=>renderNode(k,depth+1))}
   </div>}
  </section>;
 }
 return <section className={`story-directory ${['main','group'].includes(category)?'story-directory-compact':''}`} data-category={category} aria-label="分组剧情目录">
  {category==='event'&&<div className="directory-tools">
   <div className="event-switch" role="group" aria-label="活动剧情类型"><button aria-pressed={eventType==='normal'} onClick={()=>setEventType('normal')}>通常 <small>{counts['event:normal']||0}</small></button><button aria-pressed={eventType==='love'} onClick={()=>setEventType('love')}>特殊 <small>{counts['event:love']||0}</small></button></div>
  </div>}
  <div className="directory-card-grid">{visibleRoots.map(id=>renderNode(id))}</div>
  {!roots.length&&<div className="empty">此分类下没有匹配的剧情</div>}
  {category==='card'&&<ListPagination page={currentPage} pages={pages} label="卡牌剧情分页" onChange={next=>{setPage(next);window.scrollTo({top:0,left:0,behavior:'instant'})}}/>}
 </section>;
}
