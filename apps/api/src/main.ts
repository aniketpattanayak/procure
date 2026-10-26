import { createApp } from './bootstrap';
import { config } from './core/config';
import { QueueService } from './core/queue.service';

createApp()
  .then(async app => {
    // init first so every module's onModuleInit has registered its processors and repeatables.
    await app.init();
    if (config.runWorkersInline) await app.get(QueueService).startWorkers();
    return app.listen(config.port);
  })
  .then(() => console.log(`api listening on :${config.port}`))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
