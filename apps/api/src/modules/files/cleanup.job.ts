import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { DbService } from '../../core/db.service';
import { QueueService } from '../../core/queue.service';
import { FilesService } from './files.service';

export const FILES_QUEUE = 'files';
const NIL = '00000000-0000-0000-0000-000000000000';
/** Orphans younger than this are kept (an upload is attached when its record is saved; ADR-0008: 24 h). */
export const ORPHAN_AGE_HOURS = 24;

/**
 * Nightly orphan-file cleanup (ADR-0008, contract phase-2 "Files"): for every tenant with candidates
 * (`app.file_orphan_tenants`), runs FilesService.cleanupOrphans inside that tenant (RLS). One tenant failing never
 * stops the others; each run handles up to 1000 files per tenant and the next night continues.
 */
@Injectable()
export class FilesCleanupJob implements OnModuleInit {
  private readonly log = new Logger('FilesCleanup');
  constructor(private readonly db: DbService, private readonly queue: QueueService, private readonly files: FilesService) {}

  onModuleInit() {
    this.queue.registerProcessor(FILES_QUEUE, async job => (job.name === 'files-orphan-cleanup' ? this.runAll() : undefined), 1);
    this.queue.registerRepeat(FILES_QUEUE, 'files-orphan-cleanup', { pattern: '10 2 * * *' });
  }

  async runAll(olderThanHours = ORPHAN_AGE_HOURS): Promise<{ tenants: number; deleted: number }> {
    const before = new Date(Date.now() - olderThanHours * 3600_000);
    const tenants = await this.db.tenantTx(NIL, async tx =>
      (await sql<{ tenant_id: string }>`select tenant_id from app.file_orphan_tenants(${before})`.execute(tx)).rows.map(r => r.tenant_id));
    let deleted = 0;
    for (const t of tenants) {
      try {
        deleted += await this.files.cleanupOrphans(t, olderThanHours);
      } catch (e) {
        this.log.warn(`orphan cleanup failed for tenant ${t}: ${(e as Error).message}`);
      }
    }
    if (deleted) this.log.log(`orphan cleanup: ${deleted} file(s) in ${tenants.length} tenant(s)`);
    return { tenants: tenants.length, deleted };
  }
}
