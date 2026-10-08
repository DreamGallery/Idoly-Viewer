import { resourceJson, resourceCatalogBase } from './resource-snapshot';

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Users, Library, History, ChevronLeft, ChevronDown, SlidersHorizontal, ArrowDownUp, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CatalogContext } from './catalog';

import type { Catalog } from './idoly-types';
import StoryDirectory, { type Directory, type SortOrder } from './StoryDirectory';
import { buildStorySearchIndex, filterStories } from './story-search';
import { defaultCardFilters, type CardFilters } from './card-filters';
import CharacterFilter from './CharacterFilter';
import ResourceVersions from './ResourceVersions';
import ThemeSwitch from './ThemeSwitch';
import SiteInfo from './SiteInfo';
const WorkbenchPage = lazy(() => import('./workbench/Workbench').then(module => ({ default: module.WorkbenchPage })));
const StoryChapter = lazy(() => import('./StoryChapter'));
const TextUpdates = lazy(() => import('./TextUpdates'));
const MusicPlayer = lazy(() => import('./MusicPlayer'));
const sortOptions = [['default','默认排序'],['newest','从新到旧'],['oldest','从旧到新']] as const;
const statusOptions = [['all','全部翻译状态'],['empty','待翻译'],['human','待校对'],['completed','已完成']] as const;
const categories: Record<string,string> = {main:'主线剧情',group:'组合剧情',bond:'羁绊剧情',card:'卡牌剧情',event:'活动剧情',hbd:'生日剧情'};
const additionalCategories: Record<string,string> = {hometalk:'HomeTalk',message:'Message'};
export default function App(){
 const navigate=useNavigate(),route=useLocation();
 const [menuOpen,setMenuOpen]=useState(false);
 const [storiesMenuOpen,setStoriesMenuOpen]=useState(true);
 const menuButton=useRef<HTMLButtonElement>(null);
 const closeMenu=()=>{setMenuOpen(false);menuButton.current?.focus()};
 useEffect(()=>{
  if(!menuOpen)return;
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setMenuOpen(false);menuButton.current?.focus()}};
  document.addEventListener('keydown',escape);
  return ()=>document.removeEventListener('keydown',escape);
 },[menuOpen]);
 useEffect(()=>setMenuOpen(false),[route.pathname]);
 const [cardFilters,setCardFilters]=useState<CardFilters>(defaultCardFilters);
 const [sortOrder,setSortOrder]=useState<SortOrder>('default');
 const [data,setData]=useState<Catalog|null>(null),[error,setError]=useState('');
 const [category,setCategory]=useState('main'),[group,setGroup]=useState('all'),[character,setCharacter]=useState(''),[query,setQuery]=useState(''),[status,setStatus]=useState('all'),[directory,setDirectory]=useState<Directory|null>(null);
 useEffect(()=>{window.scrollTo({top:0,left:0,behavior:'instant'})},[route.pathname,category]);
 useEffect(()=>{
  let active=true;let retry:ReturnType<typeof setTimeout>|undefined;
  const load=()=>resourceJson<Catalog>('/data/catalog.json?schema=translation-status-v1',{cache:'no-cache'}).then(async catalog=>{
   const directory=await resourceJson<Directory>('/data/directory.json?schema=event-supplements-v2',{cache:'no-cache'});
   if(active){setData(catalog);setDirectory(directory);setError('')}
  }).catch((cause)=>{
   if(!active)return;
   const preparing=cause instanceof Error&&cause.message==='HTTP 503';
   setError(preparing?'剧情资源正在准备，完成后将自动载入。':'无法载入剧情目录与分组索引');
   if(preparing)retry=setTimeout(load,30000);
  });
  void load();return()=>{active=false;clearTimeout(retry)};
 },[]);
 const sortIndex=sortOptions.findIndex(([value])=>value===sortOrder);
 const statusIndex=statusOptions.findIndex(([value])=>value===status);
 const selected=route.pathname.startsWith('/chapter/')?decodeURIComponent(route.pathname.slice(9)):'';
 const view=route.pathname==='/workbench'?'tasks':route.pathname==='/updates'?'updates':'catalog';
 const setView=(v:string)=>navigate(v==='tasks'?'/workbench':v==='updates'?'/updates':'/');
 const searchIndex=useMemo(()=>buildStorySearchIndex(data,directory),[data,directory]);
 const filtered=useMemo(()=>filterStories(searchIndex,{category,character,group,status,query,cardFilters}),[searchIndex,category,character,group,status,query,cardFilters]);
 useEffect(()=>{setCharacter('');setGroup('all');setCardFilters(defaultCardFilters)},[category]);
 const filteredCardCount=useMemo(()=>directory?new Set(filtered.map(story=>directory.stories[story.id]?.group).filter(Boolean)).size:0,[directory,filtered]);
 const open=(id:string)=>navigate('/chapter/'+encodeURIComponent(id));
 const chooseGroup=(v:string)=>{setGroup(v);setCharacter('')};
 const editorCatalog=useMemo(()=>data?{build_id:data.provenance.sourceCommit,story_titles:Object.fromEntries(data.stories.map(s=>[s.id,s.title])),base_path:resourceCatalogBase(),characters:data.characters.map(c=>({...c,first_name:c.originalName,english_name:c.enName,details:{},portrait:c.image,avatar:c.image,signature:null})),speaker_avatars:data.characters.map(c=>({id:c.id,name:c.name,aliases:[c.name,c.originalName],avatar:c.image})),categories:[],entry_count:data.stories.length,script_count:data.stories.length,lists:{}}:null,[data]);
 return <CatalogContext.Provider value={editorCatalog}><header className="topbar">
 <div className="header-left"><button ref={menuButton} className="menu-toggle" aria-label={menuOpen?'收起剧情分类菜单':'展开剧情分类菜单'} aria-expanded={menuOpen} aria-controls="story-menu" onClick={()=>setMenuOpen(value=>!value)}><span className="menu-bars" aria-hidden="true"><span/><span/><span/></span><span>{menuOpen?'CLOSE':'MENU'}</span></button><div className="brand-block"><a className="brand" href="/" aria-label="IDOLY PRIDE 剧情档案" onClick={event=>{event.preventDefault();setView('catalog');setMenuOpen(false)}}><svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="110" height="14" viewBox="0 0 110 14">
                <path fillRule="evenodd" fill="currentColor" d="M92.4,0.2h-1.2v2.5h1.2c2.4,0,4.2,1.8,4.2,4.2c0,2.4-1.8,4.3-4.2,4.3h-1.2v2.5h1.2c3.7,0,6.6-3,6.6-6.8C99,3.2,96.1,0.2,92.4,0.2z M23.4,0c-3.8,0-6.8,3.1-6.8,7c0,3.9,3,7,6.8,7s6.8-3.1,6.8-7C30.2,3.1,27.1,0,23.4,0z M23.4,11.5C21,11.5,19,9.5,19,7c0-2.5,1.9-4.5,4.3-4.5c2.4,0,4.3,2,4.3,4.5C27.7,9.5,25.8,11.5,23.4,11.5z M84.9,13.8h2.5V0.2h-2.5V13.8zM0,13.8h2.5V0.2H0V13.8z M102.5,13.8h7.5v-2.5h-7.5V13.8z M102.5,8.3h7.5V5.7h-7.5V8.3z M102.5,0.2v2.5h7.5V0.2H102.5z M81.3,4c0-2.1-1.7-3.8-3.7-3.8h-6.8v2.5h6.8c0.7,0,1.2,0.6,1.2,1.3c0,0.7-0.6,1.3-1.2,1.3H73l5.5,8.5h3l-3.9-5.9C79.7,7.8,81.3,6.1,81.3,4zM64,0.2h-4.7v2.5H64c0.7,0,1.3,0.6,1.3,1.3c0,0.7-0.6,1.3-1.3,1.3h-4.7v8.5h2.5V7.8H64c2.1,0,3.8-1.7,3.8-3.8C67.8,1.9,66.1,0.2,64,0.2z M7.5,0.2H6.3v2.5h1.2c2.4,0,4.2,1.8,4.2,4.2c0,2.4-1.8,4.3-4.2,4.3H6.3v2.5h1.2c3.7,0,6.6-3,6.6-6.8C14.2,3.2,11.3,0.2,7.5,0.2z M70.8,13.8h2.5V7.8h-2.5V13.8z M46.5,5l-3.1-4.8h-3l4.9,7.5v6.1h2.5V7.7l4.9-7.5h-3L46.5,5z M36.1,0.2h-2.5v13.6h7.2v-2.5h-4.7V0.2z"></path>
              </svg></a><ResourceVersions revision={data?.provenance.revision}/></div></div>
 <nav aria-label="主导航"><button aria-current={view==='catalog'?'page':undefined} className={view==='catalog'?'active':''} onClick={()=>setView('catalog')}><Library size={17}/>剧情档案</button><button aria-current={view==='updates'?'page':undefined} className={view==='updates'?'active':''} onClick={()=>setView('updates')}><History size={17}/>文本更新</button><button aria-current={view==='tasks'?'page':undefined} className={view==='tasks'?'active':''} onClick={()=>setView('tasks')}><Users size={17}/>翻译协作</button></nav><ThemeSwitch/></header>
 <aside id="story-menu" className={`story-menu ${menuOpen?'is-open':''}`} aria-label="剧情分类菜单" aria-hidden={!menuOpen}><nav className="story-menu-list" aria-label="剧情分类">
  <button className="story-menu-parent" tabIndex={menuOpen?0:-1} aria-expanded={storiesMenuOpen} aria-controls="story-menu-categories" onClick={()=>setStoriesMenuOpen(value=>!value)}><span>通常剧情</span><ChevronDown size={19} aria-hidden="true"/></button>
  <div id="story-menu-categories" className="story-menu-children" hidden={!storiesMenuOpen}>{Object.entries(categories).map(([key,label])=><button key={key} tabIndex={menuOpen&&storiesMenuOpen?0:-1} aria-current={category===key&&view==='catalog'?'true':undefined} onClick={()=>{setCategory(key);setView('catalog');closeMenu()}}><span>{label}</span><small>{data?(searchIndex.get(key)?.length||0).toLocaleString():'—'}</small></button>)}</div>
  {Object.entries(additionalCategories).map(([key,label])=><button key={key} tabIndex={menuOpen?0:-1} aria-current={category===key&&view==='catalog'&&!selected?'true':undefined} onClick={()=>{setCategory(key);setView('catalog');closeMenu()}}><span>{label}</span></button>)}
 </nav></aside>
 {menuOpen&&<button className="menu-backdrop" aria-label="关闭剧情分类菜单" onClick={closeMenu}/>}

 <Suspense fallback={<div className="empty" role="status">正在载入页面…</div>}>{selected&&data?<main className="editor-shell"><button className="back-link" onClick={()=>navigate('/')}><ChevronLeft size={16}/>剧情档案</button><h1>{data.stories.find(s=>s.id===selected)?.title||selected}</h1><p className="story-id">{selected}</p><StoryChapter key={selected} scriptId={selected}/></main>:<main className="workspace"><section className="content">
 <div className="page-heading"><div><p className="eyebrow">{view==='tasks'?'TRANSLATION WORKSPACE':view==='updates'?'TEXT UPDATES':'IDOLY PRIDE'}</p><h2>{view==='tasks'?'翻译协作':view==='updates'?'文本更新':additionalCategories[category]||'剧情目录'}</h2></div></div>
 {error?<div role="alert" className="empty">{error}<button onClick={()=>location.reload()}>重试</button></div>:!data?<div className="empty" role="status">正在载入星见剧情档案…</div>:view==='tasks'?<WorkbenchPage/>:view==='updates'?<TextUpdates catalog={data} categories={categories}/>:additionalCategories[category]?<div className="empty">内容暂未开放</div>:<>
 {category==='card'&&<CharacterFilter data={data} directory={directory} group={group} character={character} onGroupChange={chooseGroup} onCharacterChange={setCharacter} cardFilters={cardFilters} onCardFiltersChange={setCardFilters}/>}
 <div className="filterbar"><label className="search"><Search size={19}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索剧情标题、章节或文件名" aria-label="搜索剧情"/>{query&&<button onClick={()=>setQuery('')} aria-label="清空搜索"><X size={16}/></button>}</label><div className="filter-options"><button type="button" className="filter-cycle" aria-label={'翻译状态：'+statusOptions[statusIndex][1]} title={'点击切换为'+statusOptions[(statusIndex+1)%statusOptions.length][1]} onClick={()=>setStatus(statusOptions[(statusIndex+1)%statusOptions.length][0])}><SlidersHorizontal size={16}/><span>{statusOptions[statusIndex][1]}</span></button>{['card','event'].includes(category)&&<button type="button" className="filter-cycle" aria-label={'排序：'+sortOptions[sortIndex][1]} title={'点击切换为'+sortOptions[(sortIndex+1)%3][1]} onClick={()=>setSortOrder(sortOptions[(sortIndex+1)%3][0])}><ArrowDownUp size={16}/><span>{sortOptions[sortIndex][1]}</span></button>}</div></div>
 <div className="list-heading"><h3>{character?data.characters.find(c=>c.id===character)?.name:categories[category]} <small>{category==='card'?`${filteredCardCount.toLocaleString()} 张卡牌`:`${filtered.length.toLocaleString()} 篇`}</small></h3></div>{directory?<StoryDirectory data={data} directory={directory} filtered={filtered} category={category} openStory={open} owner={character} sortOrder={sortOrder} searchKey={query.trim()}/>:<div className="empty" role="status">正在载入分组索引…</div>}</>}
 <footer><span>非官方剧情索引 · 游戏素材 <a href="https://idolypride.jp/" target="_blank" rel="noreferrer"><strong>© 2019 Project IDOLY PRIDE</strong></a></span><SiteInfo/></footer></section></main>}</Suspense>{data&&<Suspense fallback={null}><MusicPlayer/></Suspense>}</CatalogContext.Provider>;
}
