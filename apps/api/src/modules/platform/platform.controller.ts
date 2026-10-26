import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  OverrideSet, PlanInput, Principal, SubscriptionChange, TenantCreate, TenantStatusChange, TenantUpdate,
} from '@procure/schema';
import { z } from 'zod';
import { CurrentPrincipal, PlatformOnly } from '../../core/auth/decorators';
import { Zod } from '../../core/zod';
import { UuidParam } from '../identity';
import { PlansService } from './plans.service';
import { AuditListQuery, TenantListQuery, TenantsService } from './tenants.service';

type PlatformPrincipal = Extract<Principal, { kind: 'platform' }>;
const PlanUpdate = PlanInput.and(z.object({ version: z.number().int() }));
const ImpersonateBody = z.object({ reason: z.string().trim().min(3).max(500) });
const TenantId = new UuidParam('Company');

@PlatformOnly()
@Controller('platform')
export class PlatformController {
  constructor(private readonly plans: PlansService, private readonly tenants: TenantsService) {}

  // ---- catalog & plans
  @Get('catalog')
  catalog() {
    return this.plans.catalog();
  }

  @Get('plans')
  listPlans() {
    return this.plans.list();
  }

  @PlatformOnly('owner', 'billing')
  @Post('plans')
  createPlan(@Body(new Zod(PlanInput)) body: PlanInput) {
    return this.plans.create(body);
  }

  @PlatformOnly('owner', 'billing')
  @Put('plans/:id')
  updatePlan(@Param('id', new UuidParam('Plan')) id: string, @Body(new Zod(PlanUpdate)) body: z.infer<typeof PlanUpdate>) {
    return this.plans.update(id, body);
  }

  // ---- tenants
  @Get('tenants')
  listTenants(@Query(new Zod(TenantListQuery)) q: z.infer<typeof TenantListQuery>) {
    return this.tenants.list(q);
  }

  @PlatformOnly('owner', 'support')
  @Post('tenants')
  createTenant(@Body(new Zod(TenantCreate)) body: TenantCreate, @CurrentPrincipal() p: PlatformPrincipal) {
    return this.tenants.create(body, p);
  }

  @Get('tenants/:id')
  getTenant(@Param('id', TenantId) id: string) {
    return this.tenants.get(id);
  }

  @PlatformOnly('owner', 'support')
  @Put('tenants/:id')
  updateTenant(@Param('id', TenantId) id: string, @Body(new Zod(TenantUpdate)) body: z.infer<typeof TenantUpdate>) {
    return this.tenants.update(id, body);
  }

  @PlatformOnly('owner', 'support', 'billing')
  @Post('tenants/:id/suspend')
  @HttpCode(200)
  suspend(@Param('id', TenantId) id: string, @Body(new Zod(TenantStatusChange)) body: z.infer<typeof TenantStatusChange>) {
    return this.tenants.changeStatus(id, 'suspended', body);
  }

  @PlatformOnly('owner', 'support', 'billing')
  @Post('tenants/:id/reactivate')
  @HttpCode(200)
  reactivate(@Param('id', TenantId) id: string, @Body(new Zod(TenantStatusChange)) body: z.infer<typeof TenantStatusChange>) {
    return this.tenants.changeStatus(id, 'active', body);
  }

  @PlatformOnly('owner')
  @Post('tenants/:id/archive')
  @HttpCode(200)
  archive(@Param('id', TenantId) id: string, @Body(new Zod(TenantStatusChange)) body: z.infer<typeof TenantStatusChange>) {
    return this.tenants.changeStatus(id, 'archived', body);
  }

  @PlatformOnly('owner', 'billing')
  @Put('tenants/:id/overrides')
  setOverride(@Param('id', TenantId) id: string, @Body(new Zod(OverrideSet)) body: OverrideSet, @CurrentPrincipal() p: PlatformPrincipal) {
    return this.tenants.setOverride(id, body, p);
  }

  @Get('tenants/:id/overrides/history')
  overrideHistory(@Param('id', TenantId) id: string) {
    return this.tenants.overrideHistory(id);
  }

  @PlatformOnly('owner', 'billing')
  @Post('tenants/:id/subscription')
  @HttpCode(200)
  changeSubscription(
    @Param('id', TenantId) id: string,
    @Body(new Zod(SubscriptionChange)) body: z.infer<typeof SubscriptionChange>,
    @CurrentPrincipal() p: PlatformPrincipal,
  ) {
    return this.tenants.changeSubscription(id, body, p);
  }

  @Get('tenants/:id/subscriptions')
  subscriptions(@Param('id', TenantId) id: string) {
    return this.tenants.subscriptions(id);
  }

  @PlatformOnly('owner', 'support')
  @Post('tenants/:id/admin/reset-password')
  @HttpCode(200)
  resetAdminPassword(@Param('id', TenantId) id: string) {
    return this.tenants.resetAdminPassword(id);
  }

  @PlatformOnly('owner', 'support')
  @Post('tenants/:id/impersonate')
  @HttpCode(200)
  impersonate(@Param('id', TenantId) id: string, @Body(new Zod(ImpersonateBody)) body: z.infer<typeof ImpersonateBody>, @CurrentPrincipal() p: PlatformPrincipal) {
    return this.tenants.impersonate(id, body.reason, p);
  }


  @PlatformOnly('owner')
  @Post('tenants/:id/domain-permission')
  @HttpCode(200)
  setDomainPermission(@Param('id', TenantId) id: string, @Body() body: { allow: boolean }) {
    return this.tenants.setAllowCustomDomain(id, !!body.allow);
  }

  @PlatformOnly('owner', 'support')
  @Post('tenants/:id/logo')
  @HttpCode(200)
  setLogo(@Param('id', TenantId) id: string, @Body() body: { logoUrl: string | null }) {
    return this.tenants.setLogoUrl(id, body.logoUrl ?? null);
  }

  // ---- usage & audit
  @Get('usage')
  usage() {
    return this.tenants.usage();
  }

  @Get('audit')
  audit(@Query(new Zod(AuditListQuery)) q: z.infer<typeof AuditListQuery>) {
    return this.tenants.auditList(q);
  }
}
