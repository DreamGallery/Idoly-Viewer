import { useEffect, useRef, useState } from 'react';
import { Play, Pause } from 'lucide-react';
export function VoicePlayer({ clips, row, onPlay }: { clips: { url: string; label: string }[]; row: number; onPlay: (audio: HTMLAudioElement) => void }) {
  const [selected, setSelected] = useState(0), [failed, setFailed] = useState(false), [playing, setPlaying] = useState(false), [loading, setLoading] = useState(false);
  const [time, setTime] = useState(0), [duration, setDuration] = useState(0);
  const player = useRef<HTMLAudioElement>(null);
  const clip = clips[selected] || clips[0];
  useEffect(() => { const audio = player.current; return () => { audio?.pause(); }; }, [clip.url]);
  async function toggle() {
    const audio = player.current; if (!audio) return;
    if (!audio.paused) { audio.pause(); return; }
    setFailed(false); setLoading(true);
    if(audio.error) audio.load();
    try { await audio.play(); } catch { setFailed(true); } finally { setLoading(false); }
  }
  return <div className="work-voice">
    {clips.length > 1 && <select aria-label={`第 ${row} 条台词语音版本`} value={selected} onChange={e => { player.current?.pause(); setSelected(Number(e.target.value)); setFailed(false); setTime(0); setDuration(0); }}>{clips.map((c, i) => <option key={c.url} value={i}>语音 {i + 1}</option>)}</select>}
    <audio ref={player} key={clip.url} preload="none" src={clip.url} onPlay={e => { setPlaying(true); onPlay(e.currentTarget); }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={e => setTime(e.currentTarget.currentTime)} onLoadedMetadata={e => setDuration(e.currentTarget.duration)} onWaiting={() => setLoading(true)} onPlaying={() => setLoading(false)} onError={() => { setFailed(true); setPlaying(false); }} />
    <button className="work-voice-toggle" type="button" title={playing ? '暂停语音' : '播放语音'} aria-label={`${playing ? '暂停' : '播放'}第 ${row} 条语音`} onClick={toggle}>{playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}</button>
    {duration > 0 && <><input type="range" aria-label={`第 ${row} 条语音进度`} min={0} max={duration} step={0.05} value={time} onChange={e => { if (player.current) player.current.currentTime = Number(e.target.value); }} /><span>{time.toFixed(1)} / {duration.toFixed(1)} 秒</span></>}
    {loading && !failed && <small role="status">正在读取语音…</small>}{failed && <small role="status">语音暂时无法读取，点击播放重试。</small>}
  </div>;
}
