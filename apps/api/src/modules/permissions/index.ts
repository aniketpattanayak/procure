/** Public surface of the permissions module. Other modules import only from here. */
export { PermissionsModule } from './permissions.module';
export { PermissionRegistryService, SCOPED_TABS, fieldsOf, isScopedTab } from './registry.service';
export { PermissionCache } from './cache';
export { PermissionResolverService } from './resolver.service';
export { ScopeService, scopeCondition } from './scope.service';
export type { NodeFilter } from './scope.service';
export { compile, computeVisibility, expandScope, mergeFieldAccess } from './compiler';
export type { RegistryEntry, RegistrySource, ResolvedPermissions, ScopeSet } from './compiler';
export { levelLabel, loadSettings } from './settings.util';
export { LocationsService } from './locations.service';
export { labelIds } from './permissions-admin.service';
