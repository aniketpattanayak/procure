import type { SettingRow } from '@procure/schema';
import { http } from '@/lib/api';

export const settingsApi = {
  list: () => http.get<SettingRow[]>('/config/settings'),
  save: (patch: Record<string, unknown>) => http.put<SettingRow[]>('/config/settings', patch),
  labels: (lang = 'en') => http.get<Record<string, string>>('/config/labels', { lang }),
  saveLabels: (labels: Record<string, string | null>, lang = 'en') => http.put<Record<string, string>>('/config/labels', { lang, labels }),
};

export const settingsKeys = { list: ['config', 'settings'] as const, labels: (lang: string) => ['config', 'labels', lang] as const };
