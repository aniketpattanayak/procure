import { Global, Module } from '@nestjs/common';
import { PERMISSION_RESOLVER } from '../../core/auth/permissions';
import { PermissionCache } from './cache';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';
import { PermissionsAdminService } from './permissions-admin.service';
import { PermissionsController } from './permissions.controller';
import { PermissionRegistryService } from './registry.service';
import { PermissionResolverService } from './resolver.service';
import { RoleAssignmentService } from './role-assignment.service';
import { ScopeService } from './scope.service';
import { ROLE_ASSIGNMENT_GUARD } from '../identity';
import { SettingsController, SettingsService } from './settings.controller';

/**
 * Permission registry, compiler/resolver (core's PERMISSION_RESOLVER), data scope, locations, settings & labels.
 * Global so other modules can inject PermissionCache / ScopeService / PermissionRegistryService directly.
 */
@Global()
@Module({
  controllers: [PermissionsController, LocationsController, SettingsController],
  providers: [
    PermissionCache, PermissionRegistryService, PermissionResolverService, ScopeService,
    PermissionsAdminService, LocationsService, SettingsService, RoleAssignmentService,
    { provide: ROLE_ASSIGNMENT_GUARD, useExisting: RoleAssignmentService },
    { provide: PERMISSION_RESOLVER, useExisting: PermissionResolverService },
  ],
  exports: [PermissionCache, PermissionRegistryService, PermissionResolverService, ScopeService, LocationsService, RoleAssignmentService, PERMISSION_RESOLVER, ROLE_ASSIGNMENT_GUARD],
})
export class PermissionsModule {}
