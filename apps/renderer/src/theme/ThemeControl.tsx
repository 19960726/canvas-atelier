import { MonitorCog } from 'lucide-react';

import { isThemeMode, type ThemePreference } from './theme';

export function ThemeControl({ theme, compact = false }: { readonly theme: ThemePreference; readonly compact?: boolean }) {
  return (
    <label className={`theme-control${compact ? ' theme-control--compact' : ''}`} title={`当前主题：${theme.resolvedTheme}`}>
      {compact ? <span className="theme-control__compact-value">Theme · {theme.resolvedTheme === 'dark' ? 'Dark' : 'Light'}</span> : <>
        <MonitorCog aria-hidden="true" size={14} />
        <span className="theme-control__label">主题</span>
      </>}
      <select
        aria-label="主题 Theme"
        value={theme.mode}
        onChange={(event) => {
          if (isThemeMode(event.target.value)) theme.setMode(event.target.value);
        }}
      >
        <option value="system">跟随系统 System</option>
        <option value="light">浅色 Light</option>
        <option value="dark">深色 Dark</option>
      </select>
    </label>
  );
}
