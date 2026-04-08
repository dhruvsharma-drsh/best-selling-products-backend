import Fastify from 'fastify';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import { registerProductRoutes } from './routes/products.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerArchiveRoutes } from './routes/archive.js';
import { config } from '../config/env.js';
import { CATEGORY_KEYS } from '../estimation/category-curves.js';
import {
  resetBulkScrapes,
  stopScrapes,
  triggerAllCountriesScrapes,
  triggerAllScrapes,
  triggerCategoryScrape,
  scheduleAllCategories,
} from '../queue/scrape-queue.js';
import { SUPPORTED_COUNTRIES } from '../scraper/amazon-scraper.js';
import {
  DEFAULT_PRODUCT_LIMIT,
  normalizeProductLimit,
  PRODUCT_LIMIT_OPTIONS,
  SUPPORTED_COUNTRY_CONFIGS,
} from '../config/sync-config.js';

export async function createServer() {
  const prisma = new PrismaClient();
  await prisma.$connect();

  const normalizeOrigin = (origin: string) => origin.replace(/\/$/, '');
  const allowUnconfiguredOrigins = !config.isProduction && config.cors.origins.length === 0;
  const allowAllOrigins = config.cors.origins.includes('*');
  const allowedOrigins = new Set(
    config.cors.origins.filter((origin) => origin !== '*')
  );

  const app = Fastify({
    logger: config.isProduction
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
      const normalizedOrigin = origin ? normalizeOrigin(origin) : origin;

      if (
        !normalizedOrigin ||
        allowUnconfiguredOrigins ||
        allowAllOrigins ||
        allowedOrigins.has(normalizedOrigin)
      ) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${normalizedOrigin} not allowed by CORS`), false);
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
  app.post<{ Querystring: { country?: string; limit?: number } }>('/api/admin/scrape/all', async (request) => {
    const { country = 'US' } = request.query;
    const productLimit = normalizeProductLimit(request.query.limit);
    const reset = await resetBulkScrapes();
    const jobIds = await triggerAllScrapes(country, productLimit);
    return {
      success: true,
      message: `Triggered scrape for all categories in ${country}`,
      productLimit,
      replacedActiveJobId: reset.activeJobId,
      removedWaitingJobs: reset.removedWaitingJobs,
      jobIds,
    };
  });

  // Admin: trigger scrape of all countries and all categories
  app.post<{ Querystring: { country?: string; countries?: string; limit?: number; scope?: 'all' | 'selected' } }>('/api/admin/scrape/world', async (request) => {
    const normalizedCountry = (request.query.country || 'US').trim().toUpperCase();
    const selectedCountries = (request.query.countries ?? '')
      .split(',')
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean);
    const includeRemainingCountries = request.query.scope !== 'selected';
    const productLimit = normalizeProductLimit(request.query.limit);
    const startedAt = new Date().toISOString();
    const reset = await resetBulkScrapes();
    const jobIds = await triggerAllCountriesScrapes(
      normalizedCountry,
      productLimit,
      selectedCountries,
      includeRemainingCountries
    );
    const effectiveCountryCount = includeRemainingCountries
      ? SUPPORTED_COUNTRIES.length
      : Math.max(selectedCountries.length, 1);
    return {
      success: true,
      runId: jobIds[0] ?? null,
      message: `Triggered sequential scrape for all categories across all supported countries, prioritizing ${normalizedCountry}`,
      startedAt,
      priorityCountry: normalizedCountry,
      selectedCountries,
      scope: includeRemainingCountries ? 'all' : 'selected',
      productLimit,
      countryCount: effectiveCountryCount,
      categoryCount: CATEGORY_KEYS.length,
      totalJobs: effectiveCountryCount * CATEGORY_KEYS.length,
      replacedActiveJobId: reset.activeJobId,
      removedWaitingJobs: reset.removedWaitingJobs,
      jobIds,
    };
  });

  // Admin: trigger scrape of a single category
  app.post<{ Params: { category: string }, Querystring: { country?: string } }>(
    '/api/admin/scrape/:category',
    async (request) => {
      const { category } = request.params;
      const { country = 'US' } = request.query;
      const jobId = await triggerCategoryScrape(category, country, DEFAULT_PRODUCT_LIMIT);
      return {
        success: true,
        message: `Triggered scrape for ${category} in ${country}`,
        jobId,
      };
    }
  );

  // User: Real-time sync
  app.post<{ Body: { category: string, country?: string, productLimit?: number } }>(
    '/api/products/sync',
    async (request) => {
      const { category, country = 'US', productLimit } = request.body;
      const normalizedLimit = normalizeProductLimit(productLimit);
      const jobId = await triggerCategoryScrape(category, country, normalizedLimit);
      return {
        success: true,
        message: `Syncing real-time records for ${category} in ${country}`,
        productLimit: normalizedLimit,
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

  app.get('/api/meta/sync-config', async () => ({
    defaultProductLimit: DEFAULT_PRODUCT_LIMIT,
    productLimitOptions: PRODUCT_LIMIT_OPTIONS,
    countries: SUPPORTED_COUNTRY_CONFIGS,
  }));

  return { app, prisma };
}
