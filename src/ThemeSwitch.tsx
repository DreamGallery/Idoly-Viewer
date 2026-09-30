import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

export default function ThemeSwitch() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try { localStorage.setItem('campus-theme-v1', theme); } catch { /* The switch also works without storage. */ }
  }, [theme]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === 'campus-theme-v1') setTheme(event.newValue === 'dark' ? 'dark' : 'light');
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  return <div className="header-theme" role="group" aria-label="网页主题">
    <button type="button" aria-label="浅色主题" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}><Sun size={17} aria-hidden="true" /></button>
    <button type="button" aria-label="深色主题" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}><Moon size={17} aria-hidden="true" /></button>
  </div>;
}
