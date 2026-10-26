import { Module } from '@nestjs/common';
import { FilesCleanupJob } from './cleanup.job';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

@Module({
  controllers: [FilesController],
  providers: [FilesService, FilesCleanupJob],
  exports: [FilesService],
})
export class FilesModule {}
