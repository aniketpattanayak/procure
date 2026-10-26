import { Controller, Get, Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { sql } from 'kysely';
import { AuditService } from './audit.service';
import { AuthGuard } from './auth/auth.guard';
import { Public } from './auth/decorators';
import { TokenService } from './auth/token.service';
import { DbService } from './db.service';
import { DefaultEffectRegistry } from './effects.registry';
import { EFFECT_REGISTRY } from './ports';
import { QueueService } from './queue.service';
import { EntitlementsService } from './entitlements.service';
import { ProblemFilter } from './errors';
import { RedisService } from './redis.service';

@Controller('health')
class HealthController {
  constructor(private readonly db: DbService, private readonly redis: RedisService) {}
  @Public()
  @Get()
  async health() {
    await sql`select 1`.execute(this.db.platform);
    await this.redis.client.ping();
    return { status: 'ok' };
  }
}

@Global()
@Module({
  controllers: [HealthController],
  providers: [
    DbService, RedisService, TokenService, AuditService, EntitlementsService, QueueService,
    { provide: EFFECT_REGISTRY, useClass: DefaultEffectRegistry },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
  exports: [DbService, RedisService, TokenService, AuditService, EntitlementsService, QueueService, EFFECT_REGISTRY],
})
export class CoreModule {}
