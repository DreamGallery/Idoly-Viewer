import { LOADING_CYCLE_MS } from './page-motion';

export default function LoadingIndicator({ label = '正在加载页面' }: { label?: string }) {
  return <div className="loading-indicator" role="status" aria-label={label}>
    <span className="loading-mark" aria-hidden="true" />
    <span className="loading-caption" aria-hidden="true">
      {[...'LOADING...'].map((letter, index) => <span className="loading-letter" key={index} style={{ animationDelay: `${index * 90}ms`, animationDuration: `${LOADING_CYCLE_MS}ms` }}>{letter}</span>)}
    </span>
  </div>;
}
