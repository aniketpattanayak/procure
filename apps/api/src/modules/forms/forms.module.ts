import { Module } from '@nestjs/common';
import { FilesModule } from '../files';
import { ConfigFormsController, FormsRenderController, UserOptionsController } from './forms.controller';
import { FormsService } from './forms.service';
import { ConfigMastersController, MastersController } from './masters.controller';
import { MastersService } from './masters.service';
import { RecordEngine } from './record-engine';
import { RecordIoService } from './record-io.service';
import { RecordsService } from './records.service';
import { TemplateInstaller } from './template-installer';
import { UserFieldsService } from './user-fields.service';

/**
 * Form & master engine: form definitions/versions, masters, records (save pipeline), import/export, templates.
 * Must not import identity/platform (they import this module).
 */
@Module({
  imports: [FilesModule],
  controllers: [UserOptionsController, ConfigFormsController, FormsRenderController, ConfigMastersController, MastersController],
  providers: [FormsService, MastersService, RecordEngine, RecordsService, RecordIoService, TemplateInstaller, UserFieldsService],
  exports: [FormsService, MastersService, RecordEngine, RecordsService, RecordIoService, TemplateInstaller, UserFieldsService],
})
export class FormsModule {}
