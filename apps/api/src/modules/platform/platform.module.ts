import { Module } from '@nestjs/common';
import { FormsModule } from '../forms';
import { IdentityModule } from '../identity';
import { ProcurementModule } from '../procurement';
import { PlatformController } from './platform.controller';
import { PlansService } from './plans.service';
import { ProvisioningBoot } from './provisioning-boot';
import { TenantsService } from './tenants.service';

@Module({
  imports: [IdentityModule, FormsModule, ProcurementModule],
  controllers: [PlatformController],
  providers: [PlansService, TenantsService, ProvisioningBoot],
})
export class PlatformModule {}
