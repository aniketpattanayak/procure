import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { QueueService } from './core/queue.service';

/**
 * Worker process (infra/docker/worker.Dockerfile runs `node dist/worker.js`). Boots the same module graph without
 * HTTP so every module registers its processors and repeatables, then starts them.
 */
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();
  await app.get(QueueService).startWorkers();
  console.log('worker started');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
