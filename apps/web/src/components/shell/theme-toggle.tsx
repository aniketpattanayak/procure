'use client';
import { DropdownMenuItem } from '@procure/ui';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { t } from '@/i18n';
import { applyTheme, readTheme, type ThemePref } from '@/lib/theme';

const order: ThemePref[] = ['system', 'light', 'dark'];

/** Menu item that cycles System → Light → Dark. */
export function ThemeMenuItem() {
  const [pref, setPref] = useState<ThemePref>('system');
  useEffect(() => setPref(readTheme()), []);
  const Icon = pref === 'dark' ? Moon : pref === 'light' ? Sun : Monitor;
  return (
    <DropdownMenuItem
      onSelect={e => {
        e.preventDefault();
        const next = order[(order.indexOf(pref) + 1) % order.length]!;
        applyTheme(next);
        setPref(next);
      }}
      data-testid="theme-toggle"
    >
      <Icon aria-hidden />
      {t('theme.label')}: {t(`theme.${pref}`)}
    </DropdownMenuItem>
  );
}
