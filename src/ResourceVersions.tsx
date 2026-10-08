import { useEffect, useState } from 'react';
import { ChevronDown, Download } from 'lucide-react';
interface Version { revision: string | number; from_revision: string | number; filename: string; bytes: number; sha256: string; created_at: string | number }
interface Versions { revision?: string | number; versions: Version[] }
const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
export default function ResourceVersions({ revision }: { revision?: string | number | null }) {
  const [data, setData] = useState<Versions>();
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch('/api/resources/versions', { signal: controller.signal }).then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(value => { setData(value); setError(false); }).catch(e => { if (e.name !== 'AbortError') setError(true); });
    return () => controller.abort();
  }, [open]);
  return <details className="header-resource" onToggle={e => setOpen(e.currentTarget.open)} onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}>
    <summary aria-label="资源版本与下载">资源版本 {data?.revision ?? revision ?? '—'}<ChevronDown size={12} aria-hidden="true" /></summary>
    <div className="header-resource-panel"><strong>资源更新包</strong>
      <div className="resource-version-list">
        {data?.versions.slice(0, 5).map(v => (
          <a className="resource-version-item" key={v.filename} href={'/api/resources/download/' + encodeURIComponent(v.filename)} download aria-label={`下载资源更新包 ${v.from_revision} 至 ${v.revision}（${size(v.bytes)}）`}>
            <span className="resource-version-info">
              <b>Revision {v.revision}</b>
              <small>{v.from_revision} → {v.revision} · {size(v.bytes)}</small>
            </span>
            <Download size={18} aria-hidden="true" />
          </a>
        ))}
      </div>
      {!data?.versions.length && <p role="status">{error ? '版本列表暂时无法加载' : data ? '暂无可下载的资源包' : '正在加载…'}</p>}
    </div>
  </details>;
}
