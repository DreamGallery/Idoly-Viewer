import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Disc3, Headphones, ListMusic, Loader2, Maximize2, Music2, Pause, Play, Repeat, Repeat1, Search, Shuffle, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import './music-player.css';
import { resourceJson } from './resource-snapshot';

type Track = { id: string; title: string; originalTitle: string; artist: string; audio: string; cover: string; version: string };
type Mode = 'repeat' | 'single' | 'shuffle';
const modeLabels = { repeat: '列表循环', single: '单曲循环', shuffle: '随机播放' };
const clock = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;

export default function MusicPlayer() {
  const audio = useRef<HTMLAudioElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const wantsPlay = useRef(false);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [index, setIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [catalogError, setCatalogError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(.65);
  const [muted, setMuted] = useState(false);
  const [mode, setMode] = useState<Mode>('repeat');
  const [query, setQuery] = useState('');
  const track = tracks[index];

  useEffect(() => {
    const controller = new AbortController();
    setCatalogError(false);
    const request = import.meta.env.DEV
      ? fetch('/api/local-music/catalog', { signal: controller.signal }).then(async res => {
          if (!res.ok) throw Error('catalog');
          return res.json();
        })
      : resourceJson<{tracks: Track[]}>('/data/music.json', { signal: controller.signal });
    request.then(data => {
      if (!Array.isArray(data.tracks) || !data.tracks.length) throw Error('empty');
      setTracks(data.tracks);
    }).catch(err => { if (err.name !== 'AbortError') setCatalogError(true); });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    const player = audio.current;
    if (!player || !track) return;
    let active = true;
    player.src = track.audio;
    setPosition(0); setDuration(0); setError(''); setPlaying(false);
    setLoading(wantsPlay.current);
    if (wantsPlay.current) void player.play().catch(err => {
      if (active && err.name !== 'AbortError') { wantsPlay.current = false; setLoading(false); setError('播放未成功，点击重试'); }
    });
    return () => { active = false; player.pause(); };
  }, [track]);

  useEffect(() => {
    if (audio.current) { audio.current.volume = volume; audio.current.muted = muted; }
  }, [volume, muted, tracks]);

  useEffect(() => {
    // Audible dialogue takes priority; muted card animations keep the music playing.
    const pauseForMedia = (event: Event) => {
      if (event.target instanceof HTMLMediaElement && event.target !== audio.current && !event.target.muted && event.target.volume > 0) {
        wantsPlay.current = false; audio.current?.pause(); setLoading(false);
      }
    };
    document.addEventListener('play', pauseForMedia, true);
    return () => document.removeEventListener('play', pauseForMedia, true);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.showModal();
    return () => { document.body.style.overflow = previous; };
  }, [expanded]);

  const start = () => {
    const player = audio.current;
    if (!player || !track) return;
    wantsPlay.current = true; setError(''); setLoading(true);
    if (player.error) player.load();
    void player.play().catch(err => {
      if (wantsPlay.current && err.name !== 'AbortError') { wantsPlay.current = false; setLoading(false); setError('播放未成功，点击重试'); }
    });
  };
  const toggle = () => {
    if (wantsPlay.current || playing) { wantsPlay.current = false; audio.current?.pause(); setLoading(false); }
    else start();
  };
  const choose = (next: number) => {
    if (next === index) { if (audio.current) audio.current.currentTime = 0; start(); }
    else { wantsPlay.current = true; setIndex(next); }
  };
  const next = () => {
    const step = mode === 'shuffle' && tracks.length > 1 ? 1 + Math.floor(Math.random() * (tracks.length - 1)) : 1;
    choose((index + step) % tracks.length);
  };
  const close = () => { dialog.current?.close(); setExpanded(false); expandButton.current?.focus(); };
  const filtered = tracks.filter(item => `${item.title} ${item.originalTitle} ${item.artist}`.toLowerCase().includes(query.toLowerCase()));
  const playbackIcon = loading ? <Loader2 className="music-spinner" size={22}/> : playing ? <Pause size={22} fill="currentColor"/> : <Play size={22} fill="currentColor"/>;
  const modeIcon = mode === 'single' ? <Repeat1 size={19}/> : mode === 'shuffle' ? <Shuffle size={19}/> : <Repeat size={19}/>;

  // Old snapshots remain usable while the NAS prepares the first music release.
  if (!import.meta.env.DEV && !tracks.length) return null;
  return <div className="music-player">
    <audio ref={audio} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
      onPlaying={() => setLoading(false)} onWaiting={() => { if (wantsPlay.current) setLoading(true); }}
      onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
      onDurationChange={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
      onEnded={() => { if (mode === 'single') choose(index); else next(); }}
      onError={() => { wantsPlay.current = false; setPlaying(false); setLoading(false); setError('音乐载入失败，点击播放重试'); }}/>
    {!expanded && <aside className={`music-dock ${playing ? 'is-playing' : ''}`} aria-label="迷你音乐播放器">
      <button ref={expandButton} className="music-dock-track" aria-label="展开音乐播放器" aria-expanded={false} onClick={() => setExpanded(true)}>
        <span className="music-dock-cover">{track ? <img src={track.cover} alt=""/> : <Music2 size={24}/>}</span>
        <span className="music-dock-label"><strong>{track?.title || 'HOSHIMI MUSIC'}</strong><small>{error || (loading ? '正在准备音乐…' : track?.artist || (catalogError ? '曲库载入失败' : '正在载入曲库…'))}</small></span>
      </button>
      <span className="music-equalizer" aria-hidden="true"><i/><i/><i/><i/></span>
      <button className="music-play music-dock-play" disabled={!track} aria-label={playing || loading ? '暂停音乐' : '播放音乐'} onClick={toggle}>{playbackIcon}</button>
      <button className="music-icon music-dock-next" disabled={!track} aria-label="下一首" onClick={next}><SkipForward size={19}/></button>
      <button className="music-icon" aria-label="展开音乐面板" onClick={() => setExpanded(true)}><Maximize2 size={17}/></button>
      <div className="music-dock-progress" aria-hidden="true"><i style={{width: `${duration ? position / duration * 100 : 0}%`}}/></div>
    </aside>}
    <dialog ref={dialog} className="music-dialog" aria-labelledby="music-heading" onCancel={close} onClose={() => { setExpanded(false); expandButton.current?.focus(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
      {expanded && <div className="music-surface">
        <header className="music-header"><span className="music-brand"><Headphones size={20}/><span id="music-heading">HOSHIMI MUSIC</span></span><button className="music-icon" aria-label="收起音乐播放器" onClick={close}><ChevronDown size={24}/></button></header>
        <div className="music-layout">
          <section className="music-now" aria-label="正在播放">
            <div className="music-artwork">{track ? <img src={track.cover} alt={`${track.title} · 游戏歌曲封面`}/> : <Disc3 size={100}/>}<span className="music-version">{track?.version || '游戏音乐'}</span></div>
            <div className="music-track-heading"><p>NOW PLAYING</p><h2>{track?.title || '每一颗星，都有自己的声音'}</h2><span>{track?.artist || 'IDOLY PRIDE'}</span></div>
            <div className="music-timeline"><input type="range" aria-label="音乐播放进度" min={0} max={duration || 1} step={.1} disabled={!duration} value={Math.min(position, duration || 0)} style={{'--fill': `${duration ? position / duration * 100 : 0}%`} as React.CSSProperties} onChange={event => { const time=Number(event.target.value);if(audio.current)audio.current.currentTime=time;setPosition(time); }}/><div><span>{clock(position)}</span><span>{clock(duration)}</span></div></div>
            <div className="music-transport">
              <button className="music-icon music-mode" aria-label={modeLabels[mode]+'，点击切换'} onClick={() => setMode(mode === 'repeat' ? 'single' : mode === 'single' ? 'shuffle' : 'repeat')}>{modeIcon}</button>
              <button className="music-icon" disabled={!track} aria-label="上一首" onClick={() => { if(position>3&&audio.current){audio.current.currentTime=0;setPosition(0)}else choose((index-1+tracks.length)%tracks.length); }}><SkipBack size={23} fill="currentColor"/></button>
              <button className="music-play music-main-play" disabled={!track} aria-label={playing || loading ? '暂停音乐' : '播放音乐'} onClick={toggle}>{playbackIcon}</button>
              <button className="music-icon" disabled={!track} aria-label="下一首" onClick={next}><SkipForward size={23} fill="currentColor"/></button>
              <span className={`music-playing-dot ${playing ? 'active' : ''}`} aria-label={playing ? '正在播放' : '已暂停'}><i/><i/><i/></span>
            </div>
            <div className="music-volume"><button className="music-icon" aria-label={muted?'取消静音':'静音'} onClick={() => setMuted(!muted)}>{muted || volume===0 ? <VolumeX size={18}/> : <Volume2 size={18}/>}</button><input type="range" min={0} max={1} step={.01} value={muted?0:volume} aria-label="音乐音量" onChange={event => {setVolume(Number(event.target.value));setMuted(false)}}/><span>{Math.round((muted?0:volume)*100)}%</span></div>
            <p className="music-status" role="status">{error || (loading ? '首次播放正在准备资源，请稍候…' : catalogError ? '曲库暂时无法载入' : '')}{catalogError&&<button onClick={()=>setRetry(retry+1)}>重试</button>}</p>
          </section>
          <section className="music-library" aria-label="音乐曲库"><div className="music-library-heading"><h3><ListMusic size={18}/>曲目列表</h3><span>{tracks.length} 首</span></div><label className="music-search"><Search size={16}/><input aria-label="搜索音乐" value={query} placeholder="搜索歌曲或演唱者" onChange={event=>setQuery(event.target.value)}/></label>
            <div className="music-queue">{filtered.map(item=><button key={item.id} className={`music-queue-item ${track?.id===item.id?'is-current':''}`} aria-label={`播放 ${item.title} · ${item.artist}`} aria-pressed={track?.id===item.id} onClick={()=>choose(tracks.indexOf(item))}><img src={item.cover} alt="" loading="lazy"/><span><strong>{item.title}</strong><small>{item.artist}</small></span>{track?.id===item.id?<span className="music-queue-dot"/>:<Play size={14}/>}</button>)}{!filtered.length&&<p className="music-no-results">{tracks.length?'没有找到这首歌':'曲库正在准备中'}</p>}</div>
            <div className="music-library-note"><Disc3 size={15}/><span>IDOLY PRIDE · GAME SOUNDTRACK</span></div>
          </section>
        </div>
      </div>}
    </dialog>
  </div>;
}
