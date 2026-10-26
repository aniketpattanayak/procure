import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Effect, WorkflowActor } from '@procure/schema';
import { EFFECT_REGISTRY, EffectContext, EffectRegistry } from '../../core/ports';
import { ActorsService } from './actors.service';
import { DocsPortRef } from './docs-port';
import { EngineService } from './engine.service';

/** Registers the Phase 3 effects on the shared EffectRegistry. All run inside the action's transaction. */
@Injectable()
export class WorkflowEffects implements OnModuleInit {
  constructor(
    @Inject(EFFECT_REGISTRY) private readonly registry: EffectRegistry,
    private readonly docs: DocsPortRef,
    private readonly actors: ActorsService,
    private readonly engine: EngineService,
  ) {}

  onModuleInit() {
    const r = this.registry;
    r.register('lock_editing', (_e, c) => this.docs.get().setLocked(c.tx, c.documentId, true));
    r.register('unlock_editing', (_e, c) => this.docs.get().setLocked(c.tx, c.documentId, false));
    r.register('close_document', (_e, c) => this.docs.get().close(c.tx, c.documentId, 'Closed by workflow', c.actorId));
    r.register('emit', (e, c) => this.emit(e as Extract<Effect, { effect: 'emit' }>, c));
    r.register('notify', (e, c) => this.notify(e as Extract<Effect, { effect: 'notify' }>, c));
    r.register('route_to', () => this.engine.routeTo());
  }

  private emit(e: Extract<Effect, { effect: 'emit' }>, c: EffectContext) {
    return this.docs.get().emit(c.tx, e.event, { kind: 'document', id: c.documentId }, {
      documentId: c.documentId, stageKey: c.stageKey, wfActionId: c.wfActionId, approved: c.approved ?? [], rejected: c.rejected ?? [],
    });
  }

  private async notify(e: Extract<Effect, { effect: 'notify' }>, c: EffectContext) {
    const snap = await this.docs.get().snapshot(c.tx, c.documentId, { lock: false });
    const doc = { docTypeKey: snap.docTypeKey, locationPath: snap.locationPath, submittedBy: snap.submittedBy, values: snap.values };
    const ids: string[] = [];
    const actorRules: WorkflowActor[] = [];
    for (const t of e.to) {
      if (t.type === 'submitter') { if (snap.submittedBy) ids.push(snap.submittedBy); }
      else if (t.type === 'stage_actors') ids.push(...await this.engine.stageActors(c.tx, c.tenantId, c.documentId, t.stage));
      else actorRules.push(t);
    }
    if (actorRules.length) ids.push(...(await this.actors.usersOfActors(c.tx, actorRules, doc)).map(u => u.id));
    const title = e.message ?? `Update on ${snap.number ?? 'a document'}`;
    await this.engine.notify(c.tx, { tenantId: c.tenantId, snap }, ids, 'workflow_notify', title, null, { stageKey: c.stageKey });
  }
}
