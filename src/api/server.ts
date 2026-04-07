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

  const isProduction = process.env.NODE_ENV === 'production';
  const configuredOrigins = process.env.CORS_ORIGIN?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];
  const allowUnconfiguredOrigins = !isProduction && configuredOrigins.length === 0;
  const allowAllOrigins = configuredOrigins.includes('*');
  const allowedOrigins = new Set(
    configuredOrigins.filter((origin) => origin !== '*')
  );

  const app = Fastify({
    logger: isProduction
      ? { level: 'info' }
      : {
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
    origin: (origin, callback) => {
      if (
        !origin ||
        allowUnconfiguredOrigins ||
        allowAllOrigins ||
        allowedOrigins.has(origin)
      ) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} not allowed by CORS`), false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  });

  const getHealthPayload = () => ({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });

  app.get('/', async () => ({
    name: 'Amazon Sales Intelligence Platform',
    status: 'ok',
    endpoints: {
      health: '/health',
      apiHealth: '/api/health',
      products: '/api/products',
      topProducts: '/api/products/top',
      stats: '/api/stats',
      categories: '/api/categories',
    },
  }));

  app.get('/health', async () => getHealthPayload());
  app.get('/api/health', async () => getHealthPayload());

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
