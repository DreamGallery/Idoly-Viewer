import { Github } from 'lucide-react';

export default function SiteInfo() {
  return <div className="site-info">
    <a href="https://github.com/DreamGallery/Idoly-Viewer" target="_blank" rel="noopener noreferrer" aria-label="网页源代码 GitHub 仓库"><Github size={14} aria-hidden="true"/><span>GitHub</span></a>
    <span className="site-info-divider" aria-hidden="true">·</span>
    <span className="site-info-version">{import.meta.env.DEV ? '开发预览' : '版本'} · {__APP_REVISION__}</span>
  </div>;
}
