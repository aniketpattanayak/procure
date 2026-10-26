'use client';
import { Button } from '@procure/ui';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { t } from '@/i18n';
import { InlineAlert } from './page';

/** Shows a one-time secret (temporary password) with a copy button. */
export function SecretReveal({ label, value, note, testId = 'temp-password' }: { label: string; value: string; note?: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: value stays selectable */
    }
  }
  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1.5 text-sm font-medium">{label}</p>
        <div className="flex items-stretch gap-2">
          <output data-testid={testId} className="flex min-w-0 flex-1 select-all items-center rounded border border-border-strong bg-subtle px-3 font-mono text-md tracking-wide">
            {value}
          </output>
          <Button variant="secondary" onClick={copy} data-testid={`${testId}-copy`} aria-live="polite">
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? t('common.copied') : t('common.copy')}
          </Button>
        </div>
      </div>
      <InlineAlert tone="warning">{note ?? t('secret.onceNote')}</InlineAlert>
    </div>
  );
}
