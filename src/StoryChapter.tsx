import {resourceJson} from './resource-snapshot';
import {useEffect,useState} from 'react';
import {ChapterWorkbench} from './workbench/Workbench';
export type IdolyVoices={lines:{row_id:string;text:string;speaker:string;clips:{url:string;label:string}[]}[]};
export default function StoryChapter({scriptId}:{scriptId:string}){
 const [media,setMedia]=useState<{voices:IdolyVoices}|null>(null);
 const [failed,setFailed]=useState(false);
 useEffect(()=>{let active=true;setMedia(null);setFailed(false);resourceJson<{voices:IdolyVoices}>('/data/media/'+encodeURIComponent(scriptId)+'.json').then(d=>{if(active)setMedia(d)}).catch(()=>{if(active)setFailed(true)});return()=>{active=false}},[scriptId]);
 return <>{failed&&<p className="work-notice">语音索引暂时无法读取，刷新页面可重试。</p>}<ChapterWorkbench key={scriptId} scriptId={scriptId} idolyVoices={media?.voices}/></>;
}
