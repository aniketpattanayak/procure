'use client';
import type { DocTypeSummary, DocumentRow } from '@procure/schema';
import {
  Button, Dialog, DialogContent, Input, Label, NativeSelect, Segmented, Skeleton, Textarea, cn,
} from '@procure/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Hand, Pencil, X } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { newIdempotencyKey } from '@/features/documents/api';
import { EmailPreview, WhatsAppBubble } from '@/features/templates/previews';
import {
  notifyKeys, sendApi, templatesApi, triggersApi, type MessageChannel, type OutboundMessageRow, type TriggerRuleRow,
} from './api';
import { addressError } from './recipients';
import { channelLabel, MessageStatusBadge, QuotaMeter } from './ui';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?[0-9][0-9 -]{7,16}$/;

/** Normalise an Indian 10-digit mobile to E.164; leave anything else as typed. */
function normalisePhone(a: string) {
  const d = a.replace(/[\s-]/g, '');
  if (/^[6-9]\d{9}$/.test(d)) return `+91${d}`;
  return d.startsWith('+') ? d : d.length > 10 ? `+${d}` : d;
}

/**
 * Best-effort party contact for prefilling: lookup refs (vendor/party first) and header values whose key says
 * email / phone / mobile. The server re-validates every address in the preview.
 */
export function guessAddresses(doc: DocumentRow, channel: MessageChannel): string[] {
  const out: string[] = [];
  const want = (k: string) => (channel === 'email' ? /e-?mail/i.test(k) : /phone|mobile|whatsapp/i.test(k));
  const ok = (v: string) => (channel === 'email' ? EMAIL_RE.test(v) : PHONE_RE.test(v));
  const refKeys = Object.keys(doc.refs ?? {}).sort((a, b) => Number(/vendor|party|supplier/i.test(b)) - Number(/vendor|party|supplier/i.test(a)));
  for (const rk of refKeys) {
    const rec = doc.refs[rk] ?? {};
    for (const [k, v] of Object.entries(rec)) if (want(k) && typeof v === 'string' && ok(v.trim())) out.push(v.trim());
    if (out.length) break;
  }
  if (!out.length) for (const [k, v] of Object.entries(doc.values ?? {})) if (want(k) && typeof v === 'string' && ok(v.trim())) out.push(v.trim());
  return [...new Set(out.map(x => (channel === 'whatsapp' ? normalisePhone(x) : x)))].slice(0, 3);
}

export function SendDialog({ docType, doc, channels, initialChannel, onClose }: {
  docType: DocTypeSummary; doc: DocumentRow; channels: MessageChannel[]; initialChannel: MessageChannel; onClose: () => void;
}) {
  const qc = useQueryClient();
  // One idempotency key per dialog open: a double click or a retry after a timeout can't send twice.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [channel, setChannel] = useState<MessageChannel>(initialChannel);
  const [templateId, setTemplateId] = useState('');
  const [attachPdf, setAttachPdf] = useState('');
  const [recipients, setRecipients] = useState<string[]>(() => guessAddresses(doc, initialChannel));
  const [draft, setDraft] = useState('');
  const [subject, setSubject] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<OutboundMessageRow[] | null>(null);
  const ids = { tpl: useId(), pdf: useId(), rcpt: useId(), subject: useId(), body: useId() };

  const templatesQ = useQuery({ queryKey: notifyKeys.templatesAll, queryFn: () => templatesApi.list(), retry: false, staleTime: 60_000 });
  const rulesQ = useQuery({ queryKey: notifyKeys.triggers, queryFn: triggersApi.list, retry: false, staleTime: 60_000 });
  const noTemplateAccess = isApiError(templatesQ.error) && templatesQ.error.status === 403;
  const all = templatesQ.data ?? [];
  const forChannel = all.filter(x => x.channel === channel && x.isActive && (x.docTypeKey === docType.key || x.docTypeKey === null))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || Number(!!b.docTypeKey) - Number(!!a.docTypeKey));
  const pdfs = all.filter(x => x.channel === 'pdf' && x.isActive && (x.docTypeKey === docType.key || x.docTypeKey === null));
  // Manual rules for this document type are the suggested sends ("Email vendor").
  const suggestions = (rulesQ.data ?? []).filter(r => r.mode === 'manual' && r.isActive && r.channel === channel && (r.docTypeKey === docType.key || r.docTypeKey === null));

  const applyRule = (r: TriggerRuleRow) => {
    setTemplateId(r.templateId);
    setAttachPdf(r.attachPdfTemplateId ?? '');
    const fixed = r.recipients.flatMap(x => (x.type === 'fixed' ? [x.address] : []));
    const party = r.recipients.some(x => x.type === 'party') ? guessAddresses(doc, channel) : [];
    setRecipients(prev => [...new Set([...prev, ...party, ...fixed])].slice(0, 20));
    setSubject(null); setBody(null); setEditing(false);
  };

  // Channel switch resets the channel-specific choices; first suggestion (else the default template) prefills.
  useEffect(() => {
    if (!templatesQ.data) return;
    const rule = suggestions[0];
    if (rule) applyRule(rule);
    else {
      setTemplateId(forChannel[0]?.id ?? '');
      setAttachPdf(pdfs.find(x => x.isDefault)?.id ?? '');
      setRecipients(guessAddresses(doc, channel));
    }
    setSubject(null); setBody(null); setEditing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, templatesQ.data, rulesQ.data]);

  const addDraft = () => {
    const parts = draft.split(/[,;\s]+/).map(x => x.trim()).filter(Boolean).map(x => (channel === 'whatsapp' ? normalisePhone(x) : x));
    if (!parts.length) return;
    setRecipients(r => [...new Set([...r, ...parts])].slice(0, 20));
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') { e.preventDefault(); addDraft(); }
    if (e.key === 'Backspace' && !draft && recipients.length) setRecipients(r => r.slice(0, -1));
  };

  const previewInput = { channel, templateId, recipients, attachPdfTemplateId: channel !== 'inapp' && attachPdf ? attachPdf : undefined };
  const debounced = useDebounced(JSON.stringify(previewInput), 300);
  const preview = useQuery({
    queryKey: ['notify', 'send-preview', doc.id, debounced],
    queryFn: () => sendApi.preview(docType.key, doc.id, JSON.parse(debounced)),
    // Check the debounced value too: it can still hold the previous (empty) recipient list for a moment.
    enabled: !!templateId && recipients.length > 0 && !sent && (JSON.parse(debounced) as { recipients: string[]; templateId: string }).recipients.length > 0 && !!(JSON.parse(debounced) as { templateId: string }).templateId,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const pv = preview.data;
  const validity = useMemo(() => new Map((pv?.recipients ?? []).map(r => [r.address, r])), [pv]);
  const localBad = recipients.filter(a => addressError(channel, a));
  const serverBad = (pv?.recipients ?? []).filter(r => !r.valid && recipients.includes(r.address));
  const overQuota = !!pv?.quota && pv.quota.limit !== null && pv.quota.used + recipients.length > pv.quota.limit;
  const tpl = forChannel.find(x => x.id === templateId);

  async function send() {
    setError(null);
    if (!templateId) { setError(t('send.err.template')); return; }
    if (!recipients.length) { setError(t('send.err.recipients')); return; }
    if (localBad.length || serverBad.length) { setError(t('send.err.invalid')); return; }
    setSending(true);
    try {
      const rows = await sendApi.send(docType.key, doc.id, {
        ...previewInput, idempotencyKey,
        subject: channel === 'email' && subject !== null ? subject : undefined,
        body: channel === 'email' && body !== null ? body : undefined,
      });
      setSent(rows);
      void qc.invalidateQueries({ queryKey: notifyKeys.docMessages(docType.key, doc.id) });
      void qc.invalidateQueries({ queryKey: notifyKeys.messages });
    } catch (e) {
      setError(isApiError(e) ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  const shownSubject = subject ?? pv?.subject ?? '';
  const shownBody = body ?? pv?.body ?? '';

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent size="lg" className="sm:max-w-4xl" title={t('send.title', { channel: channelLabel(channel), number: doc.number ?? docType.name })} closeLabel={t('common.close')}
        data-testid="send-dialog" data-idempotency-key={idempotencyKey} data-channel={channel}
        footer={sent ? (
          <Button onClick={onClose} data-testid="send-done">{t('common.done')}</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button onClick={() => void send()} loading={sending} disabled={!templateId || !recipients.length || preview.isFetching && !pv} data-testid="send-submit">
              {t('send.submit', { n: recipients.length, channel: channelLabel(channel) })}
            </Button>
          </>
        )}>
        {sent ? (
          <div className="space-y-3" data-testid="send-result">
            <p className="flex items-center gap-2 font-medium text-success"><CheckCircle2 className="size-5" aria-hidden />{t('send.queued', { n: sent.length })}</p>
            <ul className="divide-y divide-border rounded border border-border">
              {sent.map(m => (
                <li key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm" data-testid="send-result-row" data-status={m.status}>
                  <span className="min-w-0 flex-1 truncate">{m.recipientName ? `${m.recipientName} · ` : ''}{m.recipient}</span>
                  <MessageStatusBadge status={m.status} />
                </li>
              ))}
            </ul>
            {sent.some(m => m.status === 'blocked_limit') && <InlineAlert tone="warning">{t('send.blockedLimit')}</InlineAlert>}
            {sent.some(m => m.status === 'blocked_config') && <InlineAlert tone="warning">{t('send.blockedConfig')}</InlineAlert>}
            <p className="text-sm text-fg-muted">{t('send.trackHint')}</p>
          </div>
        ) : (
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <div className="space-y-4">
              {channels.length > 1 && (
                <Segmented label={t('send.channel')} size="md" value={channel} onChange={setChannel} data-testid="send-channel"
                  options={channels.map(c => ({ value: c, label: channelLabel(c) }))} />
              )}
              {suggestions.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-sm font-medium">{t('send.suggested')}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map(r => (
                      <button key={r.id} type="button" onClick={() => applyRule(r)} data-testid={`send-suggestion-${r.id}`}
                        className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm', templateId === r.templateId ? 'border-accent bg-accent-soft text-accent' : 'border-border hover:bg-subtle')}>
                        <Hand className="size-3.5" aria-hidden />{r.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {noTemplateAccess ? (
                <InlineAlert tone="info" data-testid="send-no-templates">{t('send.noTemplateAccess')}</InlineAlert>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor={ids.tpl}>{t('send.template')}</Label>
                  <NativeSelect id={ids.tpl} value={templateId} onChange={e => { setTemplateId(e.target.value); setSubject(null); setBody(null); }} data-testid="send-template">
                    <option value="">{templatesQ.isLoading ? t('common.loading') : forChannel.length ? t('send.chooseTemplate') : t('send.noTemplates')}</option>
                    {forChannel.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </NativeSelect>
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor={ids.rcpt}>{t(channel === 'whatsapp' ? 'send.toPhones' : 'send.toEmails')}</Label>
                <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded border border-border-strong bg-surface px-2 py-1.5 focus-within:outline focus-within:outline-2 focus-within:outline-ring" data-testid="send-recipients">
                  {recipients.map(a => {
                    const bad = addressError(channel, a) ?? (validity.get(a)?.valid === false ? validity.get(a)?.reason ?? t('send.err.invalidOne') : null);
                    const name = validity.get(a)?.name;
                    return (
                      <span key={a} title={bad ?? name ?? a} data-testid="send-recipient-chip" data-valid={!bad}
                        className={cn('inline-flex max-w-full items-center gap-1 rounded-full py-0.5 pl-2 pr-1 text-sm', bad ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-fg')}>
                        <span className="truncate">{name ? <><span className="font-medium">{name}</span> <span className="text-fg-muted">{a}</span></> : a}</span>
                        <button type="button" className="rounded-full p-0.5 hover:bg-black/10" aria-label={t('send.removeRecipient', { address: a })} onClick={() => setRecipients(r => r.filter(x => x !== a))}><X className="size-3" aria-hidden /></button>
                      </span>
                    );
                  })}
                  <input id={ids.rcpt} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onKey} onBlur={addDraft}
                    inputMode={channel === 'whatsapp' ? 'tel' : 'email'} placeholder={recipients.length ? '' : channel === 'whatsapp' ? '+919812345678' : 'vendor@example.com'}
                    className="min-w-[10rem] flex-1 bg-transparent text-base outline-none" data-testid="send-recipient-input" />
                </div>
                <p className="text-xs text-fg-muted">{t('send.recipientsHint')}</p>
              </div>
              {channel !== 'inapp' && (
                <div className="space-y-1.5">
                  <Label htmlFor={ids.pdf}>{t('send.attachPdf')}</Label>
                  <NativeSelect id={ids.pdf} value={attachPdf} onChange={e => setAttachPdf(e.target.value)} data-testid="send-attach-pdf" disabled={noTemplateAccess}>
                    <option value="">{t('send.noAttachment')}</option>
                    {pdfs.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </NativeSelect>
                </div>
              )}
              {pv?.quota && channel !== 'inapp' && <QuotaMeter used={pv.quota.used} limit={pv.quota.limit} channel={channel} />}
              {overQuota && <InlineAlert tone="warning" data-testid="send-quota-warning">{t('send.quota.over', { n: recipients.length })}</InlineAlert>}
              {error && <InlineAlert data-testid="send-error">{error}</InlineAlert>}
            </div>

            <div className="min-w-0 space-y-2" data-testid="send-preview">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{t('send.preview')}</span>
                {channel === 'email' && pv && (
                  <Button size="sm" variant="ghost" onClick={() => { if (!editing) { setSubject(shownSubject); setBody(shownBody); } setEditing(e => !e); }} data-testid="send-edit-toggle" aria-pressed={editing}>
                    <Pencil aria-hidden />{editing ? t('send.showPreview') : t('send.editMessage')}
                  </Button>
                )}
              </div>
              {!templateId || !recipients.length ? (
                <p className="rounded-lg border border-dashed border-border-strong px-4 py-8 text-center text-sm text-fg-muted">{t('send.previewEmpty')}</p>
              ) : !pv && preview.isLoading ? (
                <Skeleton className="h-64" />
              ) : preview.isError && !pv ? (
                <InlineAlert data-testid="send-preview-error">{isApiError(preview.error) ? preview.error.message : t('tpl.preview.error')}</InlineAlert>
              ) : pv && channel === 'email' && editing ? (
                <div className="space-y-2">
                  <div className="space-y-1"><Label htmlFor={ids.subject}>{t('tpl.email.subject')}</Label><Input id={ids.subject} value={subject ?? ''} onChange={e => setSubject(e.target.value)} data-testid="send-subject" /></div>
                  <div className="space-y-1"><Label htmlFor={ids.body}>{t('send.bodyHtml')}</Label><Textarea id={ids.body} value={body ?? ''} onChange={e => setBody(e.target.value)} rows={14} className="font-mono text-xs" data-testid="send-body" /></div>
                  {(subject !== pv.subject || body !== pv.body) && <p className="text-xs text-warning" data-testid="send-edited">{t('send.edited')}</p>}
                </div>
              ) : pv && channel === 'email' ? (
                <EmailPreview subject={shownSubject} html={shownBody} to={recipients.join(', ')} attachments={pv.attachments.map(a => a.name)} />
              ) : pv && channel === 'whatsapp' ? (
                <WhatsAppBubble body={pv.body.replace(/<[^>]+>/g, '')} headerKind={pv.attachments.length ? 'document' : 'none'} fileName={pv.attachments[0]?.name} templateName={tpl?.name} />
              ) : pv ? (
                <p className="rounded border border-border p-3 text-sm">{pv.body}</p>
              ) : null}
              {channel === 'whatsapp' && <p className="text-xs text-fg-muted">{t('send.waNotEditable')}</p>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
