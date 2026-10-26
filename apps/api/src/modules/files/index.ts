/** Public surface of the files module (ADR-0008). */
export { FilesModule } from './files.module';
export { FilesService, isUuid, cleanFilename } from './files.service';
export { decodeImage, MAX_IMAGE_PIXELS } from './image';
export { FilesCleanupJob, FILES_QUEUE } from './cleanup.job';
export type { FileFieldRules, FileRow, UploadedBlob, AttachTarget } from './files.service';
export { acceptMatches, ALLOWED_TYPES, IMAGE_MIMES, sniff } from './sniff';
export { ClamAvScanner, NoopScanner, parseClamReply } from './scanner';
export type { Scanner, ScanResult } from './scanner';
export { LocalStorageDriver, S3StorageDriver } from './storage';
export type { StorageDriver } from './storage';
