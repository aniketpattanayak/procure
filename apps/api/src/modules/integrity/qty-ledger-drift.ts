import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { DbService } from '../../core/db.service';
import { QueueService } from '../../core/queue.service';
import { applyEvent, Buckets, emptyBuckets, fromUnits, toUnits } from '../documents';

export const INTEGRITY_QUEUE = 'integrity';
const NIL = '00000000-0000-0000-0000-000000000000';
const SAMPLE = 500;

export interface QtyDriftRow { lineId: string; documentId: string; bucket: string; stored: string; ledger: string }

/**
 * Nightly quantity-ledger drift check (ADR-0010: "A nightly job recomputes from line_event and alerts on drift"; same
 * pattern as the stock drift check). For a random sample of line_qty_summary rows per tenant, replays the line's
 * line_event rows (same effect table as the QuantityLedger, via the documents module's `applyEvent`) and compares
 * every bucket. Drift is logged, emitted (`qty_ledger.drift_detected`) and sent to the tenant admins in-app.
 * Never repairs.
 */
@Injectable()
export class QtyLedgerDriftCheck implements OnModuleInit {
  private readonly log = new Logger('QtyLedgerDrift');
  constructor(private readonly db: DbService, private readonly queue: QueueService) {}

  onModuleInit() {
    this.queue.registerProcessor(INTEGRITY_QUEUE, async job => (job.name === 'qty-ledger-drift' ? this.runAll() : undefined), 1);
    this.queue.registerRepeat(INTEGRITY_QUEUE, 'qty-ledger-drift', { pattern: '40 2 * * *' });
  }

  async runAll(): Promise<{ tenants: number; drifted: number }> {
    const tenants = await this.db.tenantTx(NIL, async tx =>
      (await sql<{ tenant_id: string }>`select tenant_id from app.qty_ledger_tenants()`.execute(tx)).rows.map(r => r.tenant_id));
    let drifted = 0;
    for (const t of tenants) {
      try {
        if ((await this.checkTenant(t)).length) drifted++;
      } catch (e) {
        this.log.warn(`quantity-ledger drift check failed for tenant ${t}: ${(e as Error).message}`);
      }
    }
    return { tenants: tenants.length, drifted };
  }

  async checkTenant(tenantId: string, sample = SAMPLE): Promise<QtyDriftRow[]> {
    return this.db.tenantTx(tenantId, async tx => {
      const sums = (await sql<Record<string, string> & { line_id: string; document_id: string }>`
        select * from app.line_qty_summary where tenant_id = ${tenantId} order by random() limit ${sample}`.execute(tx)).rows;
      if (!sums.length) return [];
      const events = (await sql<{ line_id: string; event_type: string; qty: string }>`
        select line_id, event_type, qty::text as qty from app.line_event
         where tenant_id = ${tenantId} and line_id = any(${sums.map(s => s.line_id)}::uuid[]) order by line_id, id`.execute(tx)).rows;
      const ledger = new Map<string, Buckets>();
      for (const e of events) {
        let b = ledger.get(e.line_id);
        if (!b) ledger.set(e.line_id, (b = emptyBuckets()));
        applyEvent(b, e.event_type, toUnits(e.qty)); // invariant violations are not this check's concern; totals are
      }
      const out: QtyDriftRow[] = [];
      for (const s of sums) {
        const b = ledger.get(s.line_id) ?? emptyBuckets();
        for (const k of Object.keys(b) as (keyof Buckets)[]) {
          const stored = toUnits(String(s[k] ?? '0'));
          if (stored !== b[k]) out.push({ lineId: s.line_id, documentId: s.document_id, bucket: k, stored: fromUnits(stored), ledger: fromUnits(b[k]) });
        }
      }
      if (out.length) {
        const lines = new Set(out.map(o => o.lineId)).size;
        this.log.error(`quantity-ledger drift in tenant ${tenantId}: ${lines} line(s), e.g. ${JSON.stringify(out[0])}`);
        await tx.insertInto('app.outbox_event').values({
          event_type: 'qty_ledger.drift_detected', aggregate_kind: 'document_line', aggregate_id: null,
          payload: JSON.stringify({ lines, count: out.length, rows: out.slice(0, 50) }),
        }).execute();
        const admins = await tx.selectFrom('app.tenant_user').select('id').where('is_tenant_admin', '=', true).where('is_active', '=', true).where('is_deleted', '=', false).execute();
        if (admins.length) {
          await tx.insertInto('app.notification').values(admins.map(a => ({
            tenant_id: tenantId, user_id: a.id, kind: 'qty_ledger_drift', title: 'Document quantities differ from the quantity ledger',
            body: `${lines} document line(s) have quantity totals that do not match their history. Contact support.`, link: null,
            data: JSON.stringify({ lines, count: out.length }),
          }))).execute();
        }
      }
      return out;
    });
  }
}
