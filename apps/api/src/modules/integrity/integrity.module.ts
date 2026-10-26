import { Module } from '@nestjs/common';
import { QtyLedgerDriftCheck } from './qty-ledger-drift';

/**
 * Cross-module integrity jobs that read other modules' data through their public surface only (no HTTP API):
 * the nightly quantity-ledger drift check. Stock has its own drift check (modules/stock/jobs).
 */
@Module({ providers: [QtyLedgerDriftCheck], exports: [QtyLedgerDriftCheck] })
export class IntegrityModule {}
