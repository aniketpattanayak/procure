'use client';
import type { ImportReport, MasterSummary } from '@procure/schema';
import { Button, Dialog, DialogContent, Label, NativeSelect, toast } from '@procure/ui';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, FileSpreadsheet, XCircle } from 'lucide-react';
import { useId, useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { mastersApi } from './api';

type Step = 'pick' | 'report' | 'done';

/** Download template → upload → dry-run report (row / field / message) → commit. All-or-nothing on the server. */
export function ImportDialog({ master, onClose, onImported }: { master: MasterSummary; onClose: () => void; onImported: () => void }) {
  const qc = useQueryClient();
  const fileId = useId();
  const [step, setStep] = useState<Step>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'create' | 'upsert'>('create');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await mastersApi.import(master.key, file, { dryRun, mode });
      setReport(r);
      if (!dryRun && r.errors.length === 0) {
        setStep('done');
        onImported();
        void qc.invalidateQueries({ queryKey: ['masters'] });
        void qc.invalidateQueries({ queryKey: ['lookup'] });
        toast.success(t('masters.importDone', { created: r.created, updated: r.updated }));
      } else {
        setStep('report');
      }
    } catch (e) {
      setError(isApiError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function template() {
    try { await mastersApi.template(master.key); } catch (e) { setError(isApiError(e) ? e.message : String(e)); }
  }

  const ok = report && report.errors.length === 0;

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent
        title={t('masters.importTitle', { name: master.pluralName })}
        description={step === 'pick' ? t('masters.importBody') : undefined}
        size="lg"
        closeLabel={t('common.close')}
        data-testid="import-dialog"
        footer={
          step === 'pick' ? (
            <>
              <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
              <Button onClick={() => void run(true)} disabled={!file} loading={busy} data-testid="import-check">{t('masters.importCheck')}</Button>
            </>
          ) : step === 'report' ? (
            <>
              <Button variant="secondary" onClick={() => { setStep('pick'); setReport(null); }} data-testid="import-back">{t('masters.importChooseAnother')}</Button>
              <Button onClick={() => void run(false)} disabled={!ok} loading={busy} data-testid="import-commit">
                {t('masters.importCommit', { n: report?.totalRows ?? 0 })}
              </Button>
            </>
          ) : (
            <Button onClick={onClose} data-testid="import-close">{t('common.done')}</Button>
          )
        }
      >
        <div className="space-y-4">
          {error && <InlineAlert data-testid="import-error">{error}</InlineAlert>}
          {step === 'pick' && (
            <>
              <ol className="space-y-4">
                <li className="flex gap-3">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">1</span>
                  <div className="space-y-1.5">
                    <p className="font-medium">{t('masters.importStep1')}</p>
                    <p className="text-sm text-fg-muted">{t('masters.importStep1Hint')}</p>
                    <Button size="sm" variant="secondary" onClick={() => void template()} data-testid="import-template"><Download aria-hidden />{t('masters.importTemplate')}</Button>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">2</span>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Label htmlFor={fileId} className="font-medium">{t('masters.importStep2')}</Label>
                    <p className="text-sm text-fg-muted">{t('masters.importLimits')}</p>
                    <input id={fileId} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      onChange={e => setFile(e.target.files?.[0] ?? null)} data-testid="import-file"
                      className="block w-full text-sm file:mr-3 file:rounded file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-muted" />
                    {file && <p className="flex items-center gap-1.5 text-sm"><FileSpreadsheet className="size-4 text-fg-subtle" aria-hidden />{file.name}</p>}
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">3</span>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${fileId}-mode`} className="font-medium">{t('masters.importMode')}</Label>
                    <NativeSelect id={`${fileId}-mode`} value={mode} onChange={e => setMode(e.target.value as 'create' | 'upsert')} className="w-auto" data-testid="import-mode">
                      <option value="create">{t('masters.importModeCreate')}</option>
                      <option value="upsert">{t('masters.importModeUpsert')}</option>
                    </NativeSelect>
                  </div>
                </li>
              </ol>
            </>
          )}
          {step !== 'pick' && report && (
            <div className="space-y-3" data-testid="import-report">
              <div className="flex items-start gap-2">
                {ok ? <CheckCircle2 className="mt-0.5 size-5 text-success" aria-hidden /> : <XCircle className="mt-0.5 size-5 text-danger" aria-hidden />}
                <div>
                  <p className="font-medium">
                    {step === 'done' ? t('masters.importDone', { created: report.created, updated: report.updated })
                      : ok ? t('masters.importReady', { n: report.totalRows, created: report.created, updated: report.updated })
                      : (report.errors.length === 1 ? t('masters.importProblem', { rows: report.totalRows }) : t('masters.importProblems', { n: report.errors.length, rows: report.totalRows }))}
                  </p>
                  {!ok && <p className="text-sm text-fg-muted">{t('masters.importNothingWritten')}</p>}
                </div>
              </div>
              {report.errors.length > 0 && (
                <div className="max-h-80 overflow-auto rounded border border-border">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-subtle text-left text-fg-muted">
                      <tr><th className="px-3 py-2 font-medium">{t('masters.importRow')}</th><th className="px-3 py-2 font-medium">{t('masters.importField')}</th><th className="px-3 py-2 font-medium">{t('masters.importMessage')}</th></tr>
                    </thead>
                    <tbody>
                      {report.errors.map((e, i) => (
                        <tr key={i} className="border-t border-border" data-testid="import-error-row">
                          <td className="px-3 py-1.5 tabular-nums">{e.row}</td>
                          <td className="px-3 py-1.5 font-mono text-xs">{e.field || '—'}</td>
                          <td className="px-3 py-1.5">{e.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
