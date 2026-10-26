import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { AuthResult, MyPermissions, PasswordChange, PlatformLogin, Principal, SessionRow, TenantLogin } from '@procure/schema';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AllowPendingPassword, CurrentPrincipal, CurrentSession, Public } from '../../../core/auth/decorators';
import { CurrentPermissions } from '../../../core/auth/permissions';
import { config } from '../../../core/config';
import { EntitlementsService } from '../../../core/entitlements.service';
import { Zod } from '../../../core/zod';
import { UuidParam } from '../params';
import { TenantEntitlementsService } from '../tenant-entitlements.service';
import { AuthService, LoginOutcome } from './auth.service';
import { SessionsService } from './sessions.service';

export const REFRESH_COOKIE = 'rt';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export function setRefreshCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: REFRESH_COOKIE_PATH,
    expires: expiresAt,
  });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: REFRESH_COOKIE_PATH });
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
    private readonly ent: EntitlementsService,
    private readonly tenantEnt: TenantEntitlementsService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body(new Zod(TenantLogin)) body: z.infer<typeof TenantLogin>, @Res({ passthrough: true }) res: Response): Promise<AuthResult> {
    return this.respond(res, await this.auth.tenantLogin(body.tenantCode, body.email, body.password));
  }

  @Public()
  @Post('platform/login')
  @HttpCode(200)
  async platformLogin(@Body(new Zod(PlatformLogin)) body: z.infer<typeof PlatformLogin>, @Res({ passthrough: true }) res: Response): Promise<AuthResult> {
    return this.respond(res, await this.auth.platformLogin(body.email, body.password));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<AuthResult> {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    try {
      return this.respond(res, await this.auth.refresh(token));
    } catch (e) {
      clearRefreshCookie(res);
      throw e;
    }
  }

  @AllowPendingPassword()
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentPrincipal() p: Principal, @CurrentSession() sid: string, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(p, sid);
    clearRefreshCookie(res);
  }

  @AllowPendingPassword()
  @Get('me')
  async me(@CurrentPrincipal() p: Principal, @CurrentPermissions() perms?: MyPermissions) {
    const mustChangePassword = await this.auth.mustChangePassword(p);
    if (p.kind === 'platform') return { principal: p, mustChangePassword, features: [] as string[] };
    const state = await this.ent.state(p.tenantId);
    const ent = await this.tenantEnt.build(p.tenantId);
    const { labels, settings } = await this.auth.meExtras(p.tenantId);
    // Compact MyPermissions only (the resolver's internal per-tab scope paths stay server-side).
    const permissions: MyPermissions = perms
      ? { keys: perms.keys, scope: perms.scope, fieldAccess: perms.fieldAccess, version: perms.version }
      : { keys: [], scope: { allNodes: false, nodeIds: [] }, fieldAccess: {}, version: 0 };
    // Include tenant logo so the shell can display it without a separate API call
    const logoUrl = await this.auth.tenantLogoUrl(p.tenantId);
    return { principal: p, mustChangePassword, features: state?.features ?? [], limits: ent?.limits, permissions, labels, settings, logoUrl };
  }

  @AllowPendingPassword()
  @Post('password/change')
  @HttpCode(200)
  changePassword(
    @CurrentPrincipal() p: Principal,
    @CurrentSession() sid: string,
    @Body(new Zod(PasswordChange)) body: z.infer<typeof PasswordChange>,
  ): Promise<AuthResult> {
    return this.auth.changePassword(p, sid, body.currentPassword, body.newPassword);
  }

  @Get('sessions')
  listSessions(@CurrentPrincipal() p: Principal, @CurrentSession() sid: string): Promise<SessionRow[]> {
    return this.sessions.list(p.kind, p.userId, sid, p.kind === 'tenant' ? p.tenantId : undefined);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@CurrentPrincipal() p: Principal, @Param('id', new UuidParam('Session')) id: string): Promise<void> {
    await this.auth.revokeOwnSession(p, id);
  }

  private respond(res: Response, out: LoginOutcome): AuthResult {
    setRefreshCookie(res, out.session.refreshToken, out.session.expiresAt);
    return out.result;
  }
}
