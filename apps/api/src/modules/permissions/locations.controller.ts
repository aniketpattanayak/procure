import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { LocationCreate, LocationMove, LocationUpdate, MyPermissions } from '@procure/schema';
import { z } from 'zod';
import { TenantOnly } from '../../core/auth/decorators';
import { CurrentPermissions, hasPermission, Requires } from '../../core/auth/permissions';
import { AppError } from '../../core/errors';
import { Zod } from '../../core/zod';
import { UuidParam } from '../identity';
import { LocationListQuery, LocationsService, LocationTreeQuery, LocationView } from './locations.service';
import { ScopeService } from './scope.service';

const TAB = 'admin.locations';
const A = (a: string) => `${TAB}:action.${a}`;
const NodeId = new UuidParam('Location');

/**
 * View rule (contract § Enforcement): a view the caller lacks → 403; default = first permitted.
 * `all` needs both view keys. `scope=mine` callers (any tenant user) always get the active view.
 */
export function resolveLocationView(asked: LocationView | undefined, perms: MyPermissions | undefined, mine: boolean): LocationView {
  const permitted: LocationView[] = [];
  const active = hasPermission(perms, `${TAB}:view.active`);
  const inactive = hasPermission(perms, `${TAB}:view.inactive`);
  if (active || mine) permitted.push('active');
  if (inactive) permitted.push('inactive');
  if (active && inactive) permitted.push('all');
  if (asked) {
    if (!permitted.includes(asked)) throw AppError.forbidden(`You do not have access to the ${asked} locations view`);
    return asked;
  }
  if (!permitted.length) throw AppError.forbidden('You do not have access to any locations view');
  return permitted[0]!;
}

@TenantOnly()
@Controller('locations')
export class LocationsController {
  constructor(private readonly svc: LocationsService, private readonly scope: ScopeService) {}

  /**
   * admin.locations is a scoped tab: every read and write is limited to the caller's effective scope for it
   * (all-nodes for tenant admins). `scope=all` vs `mine` only decides which key is needed: `all` needs the tab's
   * view action, `mine` is open to any tenant user (lookups).
   */
  private filter(perms: MyPermissions | undefined) {
    return this.scope.nodeFilter(perms, TAB);
  }

  private access(perms: MyPermissions | undefined, scope: 'all' | 'mine', view: LocationView | undefined) {
    if (scope === 'all' && !hasPermission(perms, A('view'))) throw AppError.forbidden();
    const v = resolveLocationView(view, perms, scope === 'mine');
    return { view: v, filter: this.filter(perms) };
  }

  @Get()
  list(@Query(new Zod(LocationListQuery)) q: z.infer<typeof LocationListQuery>, @CurrentPermissions() perms?: MyPermissions) {
    const { view, filter } = this.access(perms, q.scope, q.view);
    return this.svc.list(q, view, filter);
  }

  @Get('tree')
  tree(@Query(new Zod(LocationTreeQuery)) q: z.infer<typeof LocationTreeQuery>, @CurrentPermissions() perms?: MyPermissions) {
    const { view, filter } = this.access(perms, q.scope, q.view);
    return this.svc.tree(view, filter);
  }

  @Get(':id')
  async get(@Param('id', NodeId) id: string, @CurrentPermissions() perms?: MyPermissions) {
    const node = await this.svc.get(id, this.filter(perms)); // out of scope → 404
    // Without the tab, a user may still read an active node inside their own scope.
    if (!hasPermission(perms, A('view')) && !node.isActive) throw AppError.notFound('Location');
    return node;
  }

  @Post()
  @Requires(A('add'))
  create(@Body(new Zod(LocationCreate)) body: z.infer<typeof LocationCreate>, @CurrentPermissions() perms?: MyPermissions) {
    return this.svc.create(body, this.filter(perms));
  }

  @Put(':id')
  @Requires(A('edit'))
  update(@Param('id', NodeId) id: string, @Body(new Zod(LocationUpdate)) body: z.infer<typeof LocationUpdate>, @CurrentPermissions() perms?: MyPermissions) {
    return this.svc.update(id, body, this.filter(perms));
  }

  @Post(':id/move')
  @HttpCode(200)
  @Requires(A('move'))
  move(@Param('id', NodeId) id: string, @Body(new Zod(LocationMove)) body: z.infer<typeof LocationMove>, @CurrentPermissions() perms?: MyPermissions) {
    return this.svc.move(id, body, this.filter(perms));
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @Requires(A('deactivate'))
  deactivate(@Param('id', NodeId) id: string, @CurrentPermissions() perms?: MyPermissions) {
    return this.svc.deactivate(id, this.filter(perms));
  }

  @Post(':id/activate')
  @HttpCode(200)
  @Requires(A('deactivate'))
  activate(@Param('id', NodeId) id: string, @CurrentPermissions() perms?: MyPermissions) {
    return this.svc.activate(id, this.filter(perms));
  }

  @Delete(':id')
  @HttpCode(204)
  @Requires(A('deactivate'))
  async remove(@Param('id', NodeId) id: string, @CurrentPermissions() perms?: MyPermissions): Promise<void> {
    await this.svc.remove(id, this.filter(perms));
  }
}
