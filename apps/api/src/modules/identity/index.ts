/** Public surface of the identity module. Other modules import only from here. */
export { IdentityModule } from './identity.module';
export { AuthService } from './auth/auth.service';
export { SessionsService } from './auth/sessions.service';
export { setRefreshCookie } from './auth/auth.controller';
export { TenantEntitlementsService, countLive, monthPeriod } from './tenant-entitlements.service';
export { generateTempPassword, hashPassword } from './passwords';
export { decodeCursor, likePattern, toIso, toPage } from './pagination';
export { UuidParam } from './params';
export { enforceLiveLimit, notifyLimitCrossing } from './users/users.service';
export { getTenantSetting } from './settings';
export { ROLE_ASSIGNMENT_GUARD, assertAdminFlagChange } from './role-assignment';
export type { RoleAssignmentCaller, RoleAssignmentGuard } from './role-assignment';
