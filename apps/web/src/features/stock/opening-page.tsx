'use client';
import { Button, Card, EmptyState, FormField, Input, Textarea, toast } from '@procure/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, FileUp, Plus, Trash2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { fetchOptions } from '@/engines/form-renderer/lookup-api';
import { dec, isDecimal } from '@/features/documents/decimal';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { stockApi, stockError, stockKeys, type OpeningBody } from './api';
import { today, useScopedLocations } from './components';

interface Row { key: number; item: string; location: string; qty: string; unitCost: string; batchNo: string; expiryDate: string }
const FIELDS = ['item', 'location', 'qty', 'unitCost', 'batchNo', 'expiryDate'] as const;
type Field = typeof FIELDS[number];
const SERVER_FIELD: Record<string, Field> = { itemId: 'item', nodeId: 'location', qty: 'qty', unitCost: 'unitCost', batchNo: 'batchNo', expiryDate: 'expiryDate' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 5000;

let seq = 0;
const blank = (): Row => ({ key: ++seq, item: '', location: '', qty: '', unitCost: '', batchNo: '', expiryDate: '' });

/** Split pasted text (tab-separated from a spreadsheet, or CSV with optional quotes) into cells. */
export function parseGrid(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim() !== '');
  const tab = lines.some(l => l.includes('\t'));
  return lines.map(l => {
    if (tab) return l.split('\t').map(c => c.trim());
    const out: string[] = []; let cur = ''; let quoted = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i]!;
      if (quoted) {
        if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  });
}

/** dd-mm-yyyy / dd/mm/yyyy → yyyy-mm-dd; ISO kept. */
function normDate(s: string): string {
  const v = s.trim();
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(v);
  return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : v;
}

/** Opening balance import: paste or upload rows, resolve codes, validate per row, post in one call. */
export function OpeningPage() {
  const qc = useQueryClient();
  const locs = useScopedLocations();
  const fileRef = useRef<HTMLInputElement>(null);
  const [asOf, setAsOf] = useState(today());
  const [paste, setPaste] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [items, setItems] = useState<Map<string, { id: string; name: string } | null>>(new Map());
  const [resolving, setResolving] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<number, Partial<Record<Field, string>>>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [posted, setPosted] = useState<number | null>(null);
  const [touched, setTouched] = useState(false);

  const locByCode = useMemo(() => new Map((locs.data ?? []).map(n => [n.code.toLowerCase(), n])), [locs.data]);

  const resolveItems = async (codes: string[]) => {
    const missing = [...new Set(codes.map(c => c.trim().toLowerCase()).filter(c => c && !items.has(c)))];
    if (!missing.length) return;
    setResolving(true);
    const found = new Map(items);
    try {
      for (let i = 0; i < missing.length; i += 8) {
        await Promise.all(missing.slice(i, i + 8).map(async code => {
          const opts = await fetchOptions({ kind: 'master', masterKey: 'item' }, { q: code, limit: 10 });
          const hit = opts.find(o => (o.code ?? '').toLowerCase() === code);
          found.set(code, hit ? { id: hit.id, name: hit.name } : null);
        }));
      }
    } catch (e) {
      setError(isApiError(e) ? e.message : String(e));
    } finally {
      setItems(found);
      setResolving(false);
    }
  };

  const load = (text: string) => {
    let grid = parseGrid(text);
    if (grid.length && /item/i.test(grid[0]![0] ?? '') && !isDecimal(grid[0]![2] ?? '')) grid = grid.slice(1);
    if (grid.length > MAX_ROWS) { setError(t('stock.opening.tooMany', { n: MAX_ROWS })); return; }
    const next = grid.map(c => ({ ...blank(), item: c[0] ?? '', location: c[1] ?? '', qty: (c[2] ?? '').replace(/,/g, ''), unitCost: (c[3] ?? '').replace(/,/g, ''), batchNo: c[4] ?? '', expiryDate: normDate(c[5] ?? '') }));
    setRows(r => [...r, ...next]);
    setPaste('');
    setPosted(null);
    setServerErrors({});
    void resolveItems(next.map(r => r.item));
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    load(await f.text());
    if (fileRef.current) fileRef.current.value = '';
  };

  const update = (key: number, field: Field, value: string) => {
    setRows(rs => rs.map(r => (r.key === key ? { ...r, [field]: value } : r)));
    setServerErrors({});
  };

  const errorsOf = (r: Row): Partial<Record<Field, string>> => {
    const e: Partial<Record<Field, string>> = {};
    const code = r.item.trim().toLowerCase();
    if (!code) e.item = t('stock.opening.err.item');
    else if (items.has(code) && items.get(code) === null) e.item = t('stock.opening.err.itemUnknown');
    if (!r.location.trim()) e.location = t('stock.opening.err.location');
    else if (locs.data && !locByCode.has(r.location.trim().toLowerCase())) e.location = t('stock.opening.err.locationUnknown');
    if (!isDecimal(r.qty) || !dec.gt0(r.qty)) e.qty = t('stock.err.qty');
    if (!isDecimal(r.unitCost)) e.unitCost = t('stock.opening.err.cost');
    if (r.expiryDate && !DATE_RE.test(r.expiryDate)) e.expiryDate = t('stock.opening.err.date');
    if (r.batchNo.length > 60) e.batchNo = t('stock.opening.err.batch');
    return e;
  };
  const rowErrors = rows.map((r, i) => ({ ...errorsOf(r), ...serverErrors[i] }));
  const badCount = rowErrors.filter(e => Object.keys(e).length > 0).length;
  const dupKeys = useMemo(() => {
    const seen = new Map<string, number>(); const dups = new Set<number>();
    rows.forEach(r => {
      const k = `${r.item.trim().toLowerCase()}|${r.location.trim().toLowerCase()}|${r.batchNo.trim().toLowerCase()}`;
      if (seen.has(k)) { dups.add(r.key); dups.add(seen.get(k)!); } else seen.set(k, r.key);
    });
    return dups;
  }, [rows]);

  const post = async () => {
    setTouched(true);
    setError(null);
    if (!rows.length) return;
    if (!DATE_RE.test(asOf)) { setError(t('stock.opening.err.asOf')); return; }
    if (resolving) return;
    if (badCount) { setError(t('stock.opening.fix', { n: badCount })); return; }
    const body: OpeningBody = {
      asOf,
      rows: rows.map(r => ({
        itemId: items.get(r.item.trim().toLowerCase())!.id,
        nodeId: locByCode.get(r.location.trim().toLowerCase())!.id,
        qty: dec.norm(r.qty), unitCost: dec.norm(r.unitCost),
        ...(r.batchNo.trim() ? { batchNo: r.batchNo.trim() } : {}),
        ...(r.expiryDate ? { expiryDate: r.expiryDate } : {}),
      })),
    };
    setSaving(true);
    try {
      const res = await stockApi.opening(body);
      setPosted(res.posted);
      setRows([]);
      void qc.invalidateQueries({ queryKey: stockKeys.all });
      toast.success(t('stock.opening.done', { n: res.posted }));
    } catch (e) {
      if (isApiError(e)) {
        const per: Record<number, Partial<Record<Field, string>>> = {};
        for (const fe of e.errors) {
          const m = /^rows\.(\d+)(?:\.(\w+))?/.exec(fe.path);
          if (!m) continue;
          const idx = Number(m[1]);
          const f = SERVER_FIELD[m[2] ?? ''] ?? 'item';
          per[idx] = { ...per[idx], [f]: fe.message };
        }
        const se = stockError(e);
        se.pairs.forEach(pr => body.rows.forEach((r, idx) => { if (r.itemId === pr.itemId && r.nodeId === pr.nodeId) per[idx] = { ...per[idx], location: t('stock.opening.err.exists') }; }));
        setServerErrors(per);
        setError(se.message);
      } else setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const labels: Record<Field, string> = {
    item: t('stock.opening.col.item'), location: t('stock.opening.col.location'), qty: t('stock.qty'), unitCost: t('stock.col.unitCost'),
    batchNo: t('stock.col.batch'), expiryDate: t('stock.opening.col.expiry'),
  };

  return (
    <PageBody>
      <PageHeader
        back={<Link href="/stock" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" aria-hidden />{t('stock.title')}</Link>}
        title={t('stock.opening.title')}
        description={t('stock.opening.hint')}
      />
      {posted !== null && (
        <InlineAlert tone="success" className="mb-4" data-testid="opening-posted">
          <span className="flex items-center gap-2"><CheckCircle2 className="size-4" aria-hidden />{t('stock.opening.done', { n: posted })}</span>
        </InlineAlert>
      )}
      <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <Card className="h-fit space-y-3 p-4">
          <FormField label={t('stock.opening.asOf')} required>
            <Input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} data-testid="opening-asof" />
          </FormField>
          <FormField label={t('stock.opening.paste')} hint={t('stock.opening.format')}>
            <Textarea rows={8} value={paste} onChange={e => setPaste(e.target.value)} placeholder={'ITM-00001\tPUNE-MAIN\t100\t52.50\tB-01\t2027-03-31'} className="font-mono text-xs" data-testid="opening-paste" />
          </FormField>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => load(paste)} disabled={!paste.trim()} data-testid="opening-load"><Plus aria-hidden />{t('stock.opening.addRows')}</Button>
            <Button variant="secondary" onClick={() => fileRef.current?.click()}><FileUp aria-hidden />{t('stock.opening.upload')}</Button>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="sr-only" aria-label={t('stock.opening.upload')} onChange={e => void onFile(e.target.files?.[0])} />
            <Button variant="ghost" onClick={() => setRows(r => [...r, blank()])} data-testid="opening-add-row">{t('stock.opening.addBlank')}</Button>
          </div>
          <p className="text-xs text-fg-subtle">{t('stock.opening.rule')}</p>
        </Card>

        <div className="min-w-0 space-y-3">
          {rows.length === 0 ? <EmptyState icon={<Upload />} title={t('stock.opening.empty')} description={t('stock.opening.emptyHint')} /> : (
            <>
              <div className="overflow-x-auto rounded-lg border border-border" data-testid="opening-grid">
                <table className="w-full min-w-[52rem] text-sm">
                  <caption className="sr-only">{t('stock.opening.title')}</caption>
                  <thead className="bg-subtle text-left text-xs text-fg-muted">
                    <tr>
                      <th scope="col" className="px-2 py-2 font-medium">#</th>
                      {FIELDS.map(f => <th key={f} scope="col" className="px-2 py-2 font-medium">{labels[f]}</th>)}
                      <th scope="col" className="px-2 py-2"><span className="sr-only">{t('common.actions')}</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((r, i) => {
                      const e = rowErrors[i]!;
                      const it = items.get(r.item.trim().toLowerCase());
                      const show = touched || Object.keys(serverErrors).length > 0 || (r.item && items.has(r.item.trim().toLowerCase()));
                      return (
                        <tr key={r.key} className={Object.keys(e).length && show ? 'bg-danger-soft/30' : undefined} data-testid={`opening-row-${i}`} data-invalid={Object.keys(e).length > 0}>
                          <td className="px-2 py-1.5 align-top tabular-nums text-fg-subtle">{i + 1}</td>
                          {FIELDS.map(f => (
                            <td key={f} className="px-2 py-1.5 align-top">
                              <Input value={r[f]} onChange={ev => update(r.key, f, ev.target.value)} onBlur={() => f === 'item' && void resolveItems([r.item])}
                                className="h-8 min-w-24" inputMode={f === 'qty' || f === 'unitCost' ? 'decimal' : undefined} placeholder={f === 'expiryDate' ? 'YYYY-MM-DD' : undefined}
                                aria-label={t('stock.opening.cellLabel', { col: labels[f], n: i + 1 })} aria-invalid={(show && !!e[f]) || undefined} data-testid={`opening-${f}-${i}`} />
                              {f === 'item' && it && <span className="mt-0.5 block max-w-40 truncate text-xs text-fg-subtle">{it.name}</span>}
                              {show && e[f] && <span className="mt-0.5 block text-xs text-danger" data-testid={`opening-err-${f}-${i}`}>{e[f]}</span>}
                              {f === 'batchNo' && dupKeys.has(r.key) && <span className="mt-0.5 block text-xs text-warning">{t('stock.opening.dup')}</span>}
                            </td>
                          ))}
                          <td className="px-2 py-1.5 align-top">
                            <Button size="sm" variant="ghost" onClick={() => setRows(rs => rs.filter(x => x.key !== r.key))} aria-label={t('stock.opening.removeRow', { n: i + 1 })}><Trash2 aria-hidden /></Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {error && <InlineAlert data-testid="opening-error">{error}</InlineAlert>}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-fg-muted">{t('stock.opening.summary', { n: rows.length, bad: badCount })}{resolving ? ` · ${t('stock.opening.resolving')}` : ''}</p>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => { setRows([]); setServerErrors({}); setError(null); }}>{t('stock.opening.clear')}</Button>
                  <Button onClick={post} loading={saving} disabled={resolving} data-testid="opening-post">{t('stock.opening.post', { n: rows.length })}</Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </PageBody>
  );
}
