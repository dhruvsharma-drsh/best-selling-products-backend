import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { CATEGORY_CURVES } from '../../estimation/category-curves.js';
import { getSequentialSyncProgress } from '../../queue/scrape-queue.js';

interface CalibrationRecord {
  id: number;
  asin: string;
  category: string;
  actualMonthlySales: number;
  reportedAt: Date;
  createdAt: Date;
}

interface CategoryCurveRecord {
  category: string;
  displayName: string;
  amazonUrl: string;
  referencePoints: unknown;
  totalProductsEstimate: number | null;
  lastCalibrated: Date;
}

export function registerAdminRoutes(app: FastifyInstance, prisma: PrismaClient) {

  /**
   * GET /api/admin/calibration
   * Retrieve recent calibration records submitted via /api/admin/calibrate.
   * Useful for inspecting ground-truth data used to tune category curves.
   */
  app.get<{
    Querystring: { limit?: number; page?: number; category?: string };
  }>('/api/admin/calibration', async (request) => {
    const { limit = 50, page = 1, category } = request.query;
    const limitSafe = Math.min(Number(limit) || 50, 200);
    const pageNum = Math.max(Number(page) || 1, 1);
    const offset = (pageNum - 1) * limitSafe;

    const where = category ? { category } : {};

    const [data, total] = await Promise.all([
      prisma.calibrationData.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limitSafe,
        skip: offset,
      }),
      prisma.calibrationData.count({ where }),
    ]);

    return {
      data: data.map((d: CalibrationRecord) => ({
        id: d.id,
        asin: d.asin,
        category: d.category,
        actualMonthlySales: d.actualMonthlySales,
        reportedAt: d.reportedAt,
        createdAt: d.createdAt,
      })),
      meta: {
        total,
        page: pageNum,
        limit: limitSafe,
        totalPages: Math.ceil(total / limitSafe),
      },
    };
  });

  /**
   * GET /api/admin/category-curves
   * Returns all category curves from in-memory config AND any DB overrides.
   * The in-memory curves from category-curves.ts are the source of truth for
   * estimation; the DB `CategoryCurve` rows are stored for audit/seeding.
   */
  app.get('/api/admin/category-curves', async () => {
    // Also fetch DB rows so the admin can compare stored vs active
    const dbCurves = await prisma.categoryCurve.findMany({
      orderBy: { category: 'asc' },
    });

    const dbMap = new Map<string, CategoryCurveRecord>(dbCurves.map((c: CategoryCurveRecord) => [c.category, c]));

    return Object.entries(CATEGORY_CURVES).map(([key, config]) => {
      const dbRow = dbMap.get(key);
      return {
        category: key,
        displayName: config.displayName,
        amazonUrl: config.amazonUrl,
        totalProductsEstimate: config.totalProductsEstimate,
        referencePointCount: config.referencePoints.length,
        referencePoints: config.referencePoints,
        lastCalibrated: dbRow?.lastCalibrated ?? null,
        hasDbOverride: !!dbRow,
      };
    });
  });

  /**
   * GET /api/admin/category-curves/:category
   * Get full detail for a single category curve.
   */
  app.get<{ Params: { category: string } }>(
    '/api/admin/category-curves/:category',
    async (request, reply) => {
      const { category } = request.params;
      const config = CATEGORY_CURVES[category];
      if (!config) {
        return reply.status(404).send({ error: `Category '${category}' not found` });
      }

      const dbRow = await prisma.categoryCurve.findUnique({
        where: { category },
      });

      return {
        category,
        displayName: config.displayName,
        amazonUrl: config.amazonUrl,
        amazonNodeId: config.amazonNodeId,
        totalProductsEstimate: config.totalProductsEstimate,
        referencePoints: config.referencePoints,
        dbOverride: dbRow
          ? {
              referencePoints: dbRow.referencePoints,
              lastCalibrated: dbRow.lastCalibrated,
            }
          : null,
      };
    }
  );

  /**
   * PUT /api/admin/category-curves/:category
   * Update the DB-stored reference points for a category curve.
   * This upserts a CategoryCurve row; the estimation engine can optionally
   * read these overrides in a future enhancement.
   */
  app.put<{
    Params: { category: string };
    Body: {
      referencePoints: Array<{ bsr: number; monthlySales: number }>;
      totalProductsEstimate?: number;
    };
  }>('/api/admin/category-curves/:category', async (request, reply) => {
    const { category } = request.params;
    const { referencePoints, totalProductsEstimate } = request.body;

    const config = CATEGORY_CURVES[category];
    if (!config) {
      return reply.status(404).send({ error: `Category '${category}' not found` });
    }

    if (!referencePoints || !Array.isArray(referencePoints) || referencePoints.length < 2) {
      return reply.status(400).send({
        error: 'referencePoints must be an array with at least 2 data points',
      });
    }

    // Validate each reference point
    for (const point of referencePoints) {
      if (typeof point.bsr !== 'number' || typeof point.monthlySales !== 'number') {
        return reply.status(400).send({
          error: 'Each reference point must have numeric bsr and monthlySales fields',
        });
      }
    }

    // Sort ascending by BSR (required by the interpolation algorithm)
    const sorted = [...referencePoints].sort((a, b) => a.bsr - b.bsr);

    await prisma.categoryCurve.upsert({
      where: { category },
      create: {
        category,
        displayName: config.displayName,
        amazonUrl: config.amazonUrl,
        referencePoints: sorted as any,
        totalProductsEstimate: totalProductsEstimate ?? config.totalProductsEstimate,
        lastCalibrated: new Date(),
      },
      update: {
        referencePoints: sorted as any,
        totalProductsEstimate: totalProductsEstimate ?? undefined,
        lastCalibrated: new Date(),
      },
    });

    return {
      success: true,
      message: `Updated ${category} curve with ${sorted.length} reference points`,
      referencePoints: sorted,
    };
  });

  /**
   * GET /api/admin/scrape-jobs/stats
   * Aggregated stats about scrape jobs — counts by status, recent failures.
   */
  app.get('/api/admin/scrape-jobs/stats', async () => {
    const [statusCounts, recentFailures, avgDuration] = await Promise.all([
      prisma.$queryRaw<any[]>`
        SELECT status, COUNT(*)::int as count
        FROM scrape_jobs
        GROUP BY status
        ORDER BY status
      `,
      prisma.$queryRaw<any[]>`
        SELECT id, job_type, category_url, error_message, created_at
        FROM scrape_jobs
        WHERE status = 'failed'
        ORDER BY created_at DESC
        LIMIT 10
      `,
      prisma.$queryRaw<any[]>`
        SELECT
          ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - started_at))), 1) as avg_seconds,
          MIN(EXTRACT(EPOCH FROM (completed_at - started_at))) as min_seconds,
          MAX(EXTRACT(EPOCH FROM (completed_at - started_at))) as max_seconds
        FROM scrape_jobs
        WHERE status = 'completed'
          AND completed_at IS NOT NULL
          AND started_at IS NOT NULL
      `,
    ]);

    return {
      statusBreakdown: statusCounts.reduce(
        (acc: Record<string, number>, row: any) => {
          acc[row.status] = row.count;
          return acc;
        },
        {}
      ),
      recentFailures: recentFailures.map((f: any) => ({
        id: f.id,
        jobType: f.job_type,
        categoryUrl: f.category_url,
        errorMessage: f.error_message,
        createdAt: f.created_at,
      })),
      durationStats: avgDuration[0]
        ? {
            avgSeconds: parseFloat(avgDuration[0].avg_seconds),
            minSeconds: parseFloat(avgDuration[0].min_seconds),
            maxSeconds: parseFloat(avgDuration[0].max_seconds),
          }
        : null,
    };
  });

  /**
   * GET /api/admin/scrape-jobs/progress?since=ISO_DATE
   * Progress for the latest scrape batch, deduped by country/category pair.
   */
  app.get<{
    Querystring: { since?: string };
  }>('/api/admin/scrape-jobs/progress', async (request, reply) => {
    const { since } = request.query;

    if (!since) {
      return reply.status(400).send({ error: 'Missing required query param: since' });
    }

    const sinceDate = new Date(since);
    if (Number.isNaN(sinceDate.getTime())) {
      return reply.status(400).send({ error: 'Invalid since timestamp' });
    }

    const sequential = getSequentialSyncProgress(since);
    if (sequential) {
      return sequential;
    }

    const [statusCounts, totals, countryCountRows, recentJobs] = await Promise.all([
      prisma.$queryRaw<any[]>`
        WITH batch_jobs AS (
          SELECT DISTINCT ON (country, category_url)
            country, category_url, status
          FROM scrape_jobs
          WHERE job_type = 'bestsellers_category'
            AND created_at >= ${sinceDate}
          ORDER BY country, category_url, created_at DESC
        )
        SELECT status, COUNT(*)::int as count
        FROM batch_jobs
        GROUP BY status
        ORDER BY status
      `,
      prisma.$queryRaw<any[]>`
        WITH batch_jobs AS (
          SELECT DISTINCT ON (country, category_url)
            country, category_url, status, products_found
          FROM scrape_jobs
          WHERE job_type = 'bestsellers_category'
            AND created_at >= ${sinceDate}
          ORDER BY country, category_url, created_at DESC
        )
        SELECT
          COUNT(*)::int as started_jobs,
          COALESCE(SUM(products_found), 0)::int as products_found
        FROM batch_jobs
      `,
      prisma.$queryRaw<any[]>`
        WITH batch_jobs AS (
          SELECT DISTINCT ON (country, category_url)
            country
          FROM scrape_jobs
          WHERE job_type = 'bestsellers_category'
            AND created_at >= ${sinceDate}
          ORDER BY country, created_at DESC
        )
        SELECT COUNT(*)::int as country_count
        FROM batch_jobs
      `,
      prisma.$queryRaw<any[]>`
        WITH batch_jobs AS (
          SELECT DISTINCT ON (country, category_url)
            id, country, category_url, status, products_found, error_message, created_at, completed_at
          FROM scrape_jobs
          WHERE job_type = 'bestsellers_category'
            AND created_at >= ${sinceDate}
          ORDER BY country, category_url, created_at DESC
        )
        SELECT *
        FROM batch_jobs
        ORDER BY created_at DESC
        LIMIT 8
      `,
    ]);

    const statusBreakdown = statusCounts.reduce(
      (acc: Record<string, number>, row: any) => {
        acc[row.status] = row.count;
        return acc;
      },
      {}
    );

    return {
      startedJobs: totals[0]?.started_jobs ?? 0,
      productsFound: totals[0]?.products_found ?? 0,
      countriesStarted: countryCountRows[0]?.country_count ?? 0,
      statusBreakdown,
      recentJobs: recentJobs.map((job: any) => ({
        id: job.id,
        country: job.country,
        category: job.category_url,
        status: job.status,
        productsFound: job.products_found,
        errorMessage: job.error_message,
        createdAt: job.created_at,
        completedAt: job.completed_at,
      })),
    };
  });

  /**
   * DELETE /api/admin/scrape-jobs/failed
   * Clear all failed scrape job records from the DB.
   */
  app.delete('/api/admin/scrape-jobs/failed', async () => {
    const result = await prisma.$executeRaw`
      DELETE FROM scrape_jobs WHERE status = 'failed'
    `;
    return {
      success: true,
      message: `Deleted ${result} failed scrape job records`,
      deletedCount: result,
    };
  });
}
