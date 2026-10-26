'use client';
import { Password } from '@procure/schema';
import { cn } from '@procure/ui';
import { Check, Circle } from 'lucide-react';
import { t } from '@/i18n';

interface Rule { message: string; test: (v: string) => boolean }

/** Rules read straight from the shared Zod `Password` schema, so the checklist can never drift from the server. */
function rulesFromSchema(): Rule[] {
  const checks = (Password._def as { checks?: { kind: string; value?: number; regex?: RegExp; message?: string }[] }).checks ?? [];
  const rules: Rule[] = [];
  for (const c of checks) {
    if (c.kind === 'min' && typeof c.value === 'number') {
      const n = c.value;
      rules.push({ message: c.message ?? t('password.min', { n }), test: v => v.length >= n });
    } else if (c.kind === 'regex' && c.regex) {
      const re = c.regex;
      rules.push({ message: c.message ?? re.source, test: v => re.test(v) });
    }
  }
  return rules;
}

const RULES = rulesFromSchema();

export function PasswordRules({ value, id }: { value: string; id?: string }) {
  return (
    <ul id={id} className="space-y-1" aria-label={t('password.requirements')} data-testid="password-rules">
      {RULES.map(r => {
        const ok = r.test(value);
        return (
          <li key={r.message} className={cn('flex items-center gap-2 text-sm', ok ? 'text-success' : 'text-fg-muted')} data-ok={ok}>
            {ok ? <Check className="size-3.5" aria-hidden /> : <Circle className="size-3" aria-hidden />}
            <span>{r.message}</span>
            <span className="sr-only">{ok ? t('password.ruleMet') : t('password.ruleNotMet')}</span>
          </li>
        );
      })}
    </ul>
  );
}
