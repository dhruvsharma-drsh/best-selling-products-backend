import Fastify from 'fastify';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import { registerProductRoutes } from './routes/products.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerArchiveRoutes } from './routes/archive.js';
import {
  stopScrapes,
  triggerAllScrapes,
  triggerCategoryScrape,
  scheduleAllCategories,
} from '../queue/scrape-queue.js';

export async function createServer() {
  const prisma = new PrismaClient();
  await prisma.$connect();

  const app = Fastify({
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      },
    },
  });

  // CORS for frontend
  await app.register(cors, {
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  });

  // Health check
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));

  // Register product routes
  registerProductRoutes(app, prisma);

  // Register admin routes
  registerAdminRoutes(app, prisma);

  // Register archive routes (Wayback Machine historical data)
  registerArchiveRoutes(app, prisma);

  // Admin: trigger scrape of all categories
  app.post<{ Querystring: { country?: string } }>('/api/admin/scrape/all', async (request) => {
    const { country = 'US' } = request.query;
    const jobIds = await triggerAllScrapes(country);
    return {
      success: true,
      message: `Triggered scrape for all categories in ${country}`,
      jobIds,
    };
  });

  // Admin: trigger scrape of a single category
  app.post<{ Params: { category: string }, Querystring: { country?: string } }>(
    '/api/admin/scrape/:category',
    async (request) => {
      const { category } = request.params;
      const { country = 'US' } = request.query;
      const jobId = await triggerCategoryScrape(category, country, 50);
      return {
        success: true,
        message: `Triggered scrape for ${category} in ${country}`,
        jobId,
      };
    }
  );

  // User: Real-time sync
  app.post<{ Body: { category: string, country?: string } }>(
    '/api/products/sync',
    async (request) => {
      const { category, country = 'US' } = request.body;
      const jobId = await triggerCategoryScrape(category, country, 50);
      return {
        success: true,
        message: `Syncing real-time records for ${category} in ${country}`,
        jobId,
      };
    }
  );

  app.post<{ Body: { kind?: 'bulk' | 'realtime' } }>(
    '/api/products/sync/stop',
    async (request) => {
      const { kind = 'realtime' } = request.body ?? {};
      const result = await stopScrapes(kind);
      return {
        success: true,
        ...result,
      };
    }
  );

  // Admin: schedule recurring scrapes
  app.post('/api/admin/schedule', async () => {
    await scheduleAllCategories();
    return {
      success: true,
      message: 'Recurring schedule set up',
    };
  });

  return { app, prisma };
}
