import './config/env.js';

import { createServer } from './api/server.js';
import { createScrapeWorker, quarantineLegacyQueues, ScrapeQueueKind } from './queue/scrape-queue.js';

async function main() {
  console.log('Starting Amazon Sales Intelligence Platform...');

  const { app, prisma } = await createServer();
  await quarantineLegacyQueues();

  const attachWorkerLogging = (queueKind: ScrapeQueueKind) => {
    const worker = createScrapeWorker(prisma, queueKind);

    worker.on('completed', (job) => {
      console.log(`Completed ${queueKind} scrape job: ${job.name}`);
    });

    worker.on('failed', (job, err) => {
      console.error(`Failed ${queueKind} scrape job: ${job?.name}`, err.message);
    });

    return worker;
  };

  const realtimeWorker = attachWorkerLogging('realtime');
  const bulkWorker = attachWorkerLogging('bulk');

  const port = parseInt(process.env.PORT || '3001');
  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, '');
  const formatEndpoint = (path: string) =>
    publicBaseUrl ? `${publicBaseUrl}${path}` : path;

  await app.listen({ port, host: '0.0.0.0' });

  console.log('\n' + '='.repeat(58));
  console.log('  Amazon Sales Intelligence Platform');
  console.log(`  Port:            ${port}`);
  console.log(`  Base URL:        ${publicBaseUrl || 'set PUBLIC_BASE_URL to show a public URL'}`);
  console.log(`  Root:            ${formatEndpoint('/')}`);
  console.log(`  Health:          ${formatEndpoint('/health')}`);
  console.log(`  API Health:      ${formatEndpoint('/api/health')}`);
  console.log(`  Products:        ${formatEndpoint('/api/products')}`);
  console.log(`  Top Products:    ${formatEndpoint('/api/products/top')}`);
  console.log(`  Stats:           ${formatEndpoint('/api/stats')}`);
  console.log(`  Categories:      ${formatEndpoint('/api/categories')}`);
  console.log(`  Admin Curves:    ${formatEndpoint('/api/admin/category-curves')}`);
  console.log(`  Admin Calibrate: ${formatEndpoint('/api/admin/calibration')}`);
  console.log(`  Scrape Stats:    ${formatEndpoint('/api/admin/scrape-jobs/stats')}`);
  console.log('='.repeat(58) + '\n');

  const shutdown = async () => {
    console.log('\nShutting down...');
    await Promise.all([
      realtimeWorker.close(),
      bulkWorker.close(),
    ]);
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
