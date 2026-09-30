import { useRef, useState } from 'react';
import { X, Play } from 'lucide-react';
import type { Entry } from './catalog';
export type CardVideo={url:string;label:string;poster?:string;aspect_ratio?:number};

export default function CardPreview({images,title,videos=[],compact=false,portrait=false,zoomable=true}:{images:NonNullable<Entry['group_images']>;title:string;videos?:CardVideo[];compact?:boolean;portrait?:boolean;zoomable?:boolean}){
 const dialog=useRef<HTMLDialogElement>(null),player=useRef<HTMLVideoElement>(null);
 const [visible,setVisible]=useState(false),[selected,setSelected]=useState(0),[movie,setMovie]=useState(false),[loading,setLoading]=useState(false),[failed,setFailed]=useState(false);
 const open=(index:number,video=false)=>{setVisible(true);player.current?.pause();setSelected(index);setMovie(video);setLoading(video);setFailed(false);dialog.current?.showModal()};
 const close=()=>{player.current?.pause();dialog.current?.close();setMovie(false);setVisible(false)};
 const image=images[selected]||images[0],video=videos[selected]||videos[0];
 const imageLabel=(label:string)=>label.startsWith(title)?label:title+' '+label;
 const selectedLabel=movie?video?.label:image?.label;
 const previewTitle=selectedLabel?.startsWith(title)?selectedLabel:title;
 const Preview = zoomable ? 'button' : 'div';
 return <>
  <div className={(compact?'group-cover-preview':'card-previews')+(portrait?' character-portrait-preview':'')}>
   {(compact?images.slice(0,portrait?2:1):images).map((item,index)=><Preview key={item.url} className={'card-preview'+(zoomable?'':' card-preview-static')} aria-label={zoomable?'放大 '+imageLabel(item.label):undefined} onClick={zoomable?()=>open(index):undefined}>
    <img style={{aspectRatio:item.aspect_ratio||undefined,objectFit:item.aspect_ratio?'fill':'contain'}} src={item.url} alt={imageLabel(item.label)} loading="lazy"/>
    {!compact&&images.length>1&&<span>{item.label}</span>}
   </Preview>)}
   {zoomable&&videos.length>0&&<button className="animated-card-button" onClick={()=>open(0,true)} aria-label={'播放 '+title+' 动态卡面'}><Play size={15}/>动态卡面</button>}
  </div>
  {zoomable&&<dialog ref={dialog} className="card-lightbox" aria-label={title+' 图片与动态卡面预览'} onCancel={close} onClose={()=>{player.current?.pause();setMovie(false);setVisible(false)}} onClick={event=>{if(event.target===event.currentTarget)close()}}>
   <div className="lightbox-toolbar"><span>{previewTitle}{movie?' · 动态卡面':''}</span><button autoFocus aria-label="关闭卡面预览" onClick={close}><X/></button></div>
   {visible&&(movie&&video?<><video key={video.url} ref={player} src={video.url} poster={video.poster} controls autoPlay muted loop playsInline preload="none" style={{aspectRatio:video.aspect_ratio||16/9}} onWaiting={()=>setLoading(true)} onPlaying={()=>setLoading(false)} onError={()=>{setFailed(true);setLoading(false)}}/>{loading&&<p role="status" className="media-loading">正在读取动态卡面…</p>}{failed&&<p role="status">动态卡面暂时无法读取。<button onClick={()=>{setFailed(false);setLoading(true);player.current?.load();player.current?.play().catch(()=>setFailed(true))}}>重试</button></p>}</>:image&&<img style={{aspectRatio:image.aspect_ratio||undefined,objectFit:image.aspect_ratio?'fill':'contain',width:image.aspect_ratio?'min(86vw, '+70*image.aspect_ratio+'dvh)':undefined}} src={image.url} alt={imageLabel(image.label)}/>)}
   {(images.length+videos.length>1)&&<div className="lightbox-stages">{images.map((item,index)=><button key={item.url} aria-pressed={!movie&&selected===index} onClick={()=>open(index)}>{item.label}</button>)}{videos.map((item,index)=><button key={item.url} aria-label={'播放 '+item.label+' 动态卡面'} aria-pressed={movie&&selected===index} onClick={()=>open(index,true)}><Play size={13}/>{item.label}</button>)}</div>}
  </dialog>}
 </>;
}
