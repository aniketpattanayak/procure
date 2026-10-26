import Link from 'next/link';
import { t } from '@/i18n';

export default function NotFound() {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-xl font-semibold">{t('notFound.title')}</p>
      <p className="text-fg-muted">{t('notFound.body')}</p>
      <Link href="/" className="text-accent hover:underline">{t('notFound.home')}</Link>
    </main>
  );
}
