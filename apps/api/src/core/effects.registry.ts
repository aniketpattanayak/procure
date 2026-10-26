import { Injectable } from '@nestjs/common';
import type { Effect } from '@procure/schema';
import { AppError } from './errors';
import type { EffectContext, EffectHandler, EffectRegistry } from './ports';

/** Default in-process effect registry (provided under EFFECT_REGISTRY by CoreModule). */
@Injectable()
export class DefaultEffectRegistry implements EffectRegistry {
  private readonly handlers = new Map<string, { fn: EffectHandler; requiresFeature?: string }>();

  register(effect: Effect['effect'], handler: EffectHandler, opts: { requiresFeature?: string } = {}) {
    if (this.handlers.has(effect)) throw new Error(`effect ${effect} already registered`);
    this.handlers.set(effect, { fn: handler, requiresFeature: opts.requiresFeature });
  }

  available(tenantFeatures: string[]): Effect['effect'][] {
    return [...this.handlers.entries()]
      .filter(([, h]) => !h.requiresFeature || tenantFeatures.includes(h.requiresFeature))
      .map(([k]) => k as Effect['effect']);
  }

  async run(effect: Effect, ctx: EffectContext) {
    const h = this.handlers.get(effect.effect);
    if (!h) throw new AppError(409, 'EFFECT_UNAVAILABLE', `The workflow uses "${effect.effect}", which is not available.`);
    await h.fn(effect, ctx);
  }
}
