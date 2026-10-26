import { FormsModule } from '../forms';
import { Module } from '@nestjs/common';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { SessionsService } from './auth/sessions.service';
import { TenantEntitlementsService } from './tenant-entitlements.service';
import { NotificationsController, RolesController, TenantUsageController, UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

@Module({
  imports: [FormsModule],
  controllers: [AuthController, UsersController, RolesController, NotificationsController, TenantUsageController],
  providers: [AuthService, SessionsService, UsersService, TenantEntitlementsService],
  exports: [AuthService, SessionsService, TenantEntitlementsService],
})
export class IdentityModule {}
