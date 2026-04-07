import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import {
  estimateMonthlySales,
  calculateBsrStabilityScore,
  calculateTrend,
} from '../../estimation/sales-estimator.js';
import { CATEGORY_CURVES } from '../../estimation/category-curves.js';
import { convertToUsd, getCountryCurrency } from '../../lib/currency-rates.js';

interface SnapshotRow {
  time: Date;
  bsr_category: number;
  estimated_monthly_sales: number | null;
  estimated_monthly_revenue: string | null;
  price_usd: string | null;
  rating: string | null;
  review_count: number | null;
}

interface ProductRecord {
  asin: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  productUrl: string;
  primaryCategory: string;
  subcategory: string | null;
  priceUsd: { toString(): string } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductQueryParams {
  country?: string;
  startDate?: string;
  endDate?: string;
  category?: string;
  limit?: number;
  page?: number;
  sortBy?: 'estimated_sales' | 'bsr' | 'revenue';
  search?: string;
}

export function registerProductRoutes(app: FastifyInstance, prisma: PrismaClient) {

  /**
   * GET /api/products
   * Lightweight product catalog search — no time-series aggregation.
   * Useful for admin views, autocomplete, and simple product lookups.
   */
  app.get<{
    Querystring: {
      search?: string;
      category?: string;
      brand?: string;
      limit?: number;
      page?: number;
      sortBy?: 'title' | 'createdAt' | 'updatedAt' | 'priceUsd';
      sortDir?: 'asc' | 'desc';
    };
  }>('/api/products', async (request) => {
    const {
      search,
      category,
      brand,
      limit = 50,
      page = 1,
      sortBy = 'updatedAt',
      sortDir = 'desc',
    } = request.query;

    const limitSafe = Math.min(Number(limit) || 50, 200);
    const pageNum = Math.max(Number(page) || 1, 1);
    const offset = (pageNum - 1) * limitSafe;

    // Build Prisma where clause
    const where: any = {};
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { asin: { equals: search.toUpperCase() } },
      ];
    }
    if (category && category !== 'all') {
      where.primaryCategory = category;
    }
    if (brand) {
      where.brand = { contains: brand, mode: 'insensitive' };
    }

    const orderBy: any = {};
    const validSorts = ['title', 'createdAt', 'updatedAt', 'priceUsd'];
    orderBy[validSorts.includes(sortBy) ? sortBy : 'updatedAt'] = sortDir === 'asc' ? 'asc' : 'desc';

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy,
        take: limitSafe,
        skip: offset,
      }),
      prisma.product.count({ where }),
    ]);

    return {
      data: products.map((p: ProductRecord) => ({
        asin: p.asin,
        title: p.title,
        brand: p.brand,
        imageUrl: p.imageUrl,
        productUrl: p.productUrl,
        category: p.primaryCategory,
        subcategory: p.subcategory,
        priceUsd: p.priceUsd ? parseFloat(p.priceUsd.toString()) : null,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
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
   * GET /api/products/top
   * Returns highest selling products across all categories or filtered.
   */
  app.get<{ Querystring: ProductQueryParams }>(
    '/api/products/top',
    async (request, reply) => {
      const {
        country = 'US',
        startDate,
        endDate,
        category,
        limit = 50,
        page = 1,
        sortBy = 'estimated_sales',
        search,
      } = request.query;

      const limitSafe = Math.min(Number(limit) || 50, 200);
      const pageNum = Math.max(Number(page) || 1, 1);
      const offset = (pageNum - 1) * limitSafe;

      let whereCategory = '';
      let whereSearch = '';
      const params: any[] = [country]; // param $1 is always country

      if (category && category !== 'all') {
        whereCategory = `AND s.category = $${params.length + 1}`;
        params.push(category);
      }

      // Use raw SQL for the complex time-series aggregation
      let whereCustomDates = '';
      if (startDate) {
        whereCustomDates += ` AND s.time >= $${params.length + 1}`;
        params.push(new Date(startDate));
      } else {
        whereCustomDates += ` AND s.time >= NOW() - INTERVAL '30 days'`;
      }
      if (endDate) {
        whereCustomDates += ` AND s.time <= $${params.length + 1}`;
        const endDateObj = new Date(endDate);
        // Set to end of day so the entire end date is included
        endDateObj.setUTCHours(23, 59, 59, 999);
        params.push(endDateObj);
      }

      const sortColumn = sortBy === 'revenue'
        ? 'estimated_monthly_revenue'
        : sortBy === 'bsr'
        ? 'bsr_category'
        : 'estimated_monthly_sales';

      const sortDirection = sortBy === 'bsr' ? 'ASC' : 'DESC';

      try {
        const results = await prisma.$queryRawUnsafe<any[]>(`
          WITH latest_snapshots AS (
            SELECT DISTINCT ON (s.asin)
              s.asin,
              s.country,
              s.bsr_category,
              s.category,
              s.estimated_monthly_sales,
              s.estimated_monthly_revenue,
              s.review_count,
              s.rating,
              s.price_usd,
              s.time
            FROM bsr_snapshots s
            WHERE s.country = $1
            ${whereCategory}
            ${whereCustomDates}
            ORDER BY s.asin, s.time DESC
          )
          SELECT
            ls.*,
            p.title,
            p.brand,
            p.image_url,
            p.product_url,
            ROW_NUMBER() OVER (ORDER BY ls.${sortColumn} ${sortDirection} NULLS LAST) as rank
          FROM latest_snapshots ls
          JOIN products p ON p.asin = ls.asin AND p.country = ls.country
          ${search ? `WHERE p.title ILIKE '%' || $${params.length + 1} || '%'` : ''}
          ORDER BY ls.${sortColumn} ${sortDirection} NULLS LAST
          LIMIT ${limitSafe} OFFSET ${offset}
        `, ...params, ...(search ? [search] : []));

        const totalResult = await prisma.$queryRawUnsafe<any[]>(`
          SELECT COUNT(DISTINCT s.asin) as count
          FROM bsr_snapshots s
          ${search ? `JOIN products p ON p.asin = s.asin AND p.country = s.country` : ''}
          WHERE s.country = $1
          ${whereCategory}
          ${whereCustomDates}
          ${search ? `AND p.title ILIKE '%' || $${params.length + 1} || '%'` : ''}
        `, ...params, ...(search ? [search] : []));

        const total = parseInt(totalResult[0]?.count ?? '0');

        return {
          data: results.map(formatProduct),
          meta: {
            total,
            page: pageNum,
            limit: limitSafe,
            country,
            totalPages: Math.ceil(total / limitSafe),
          },
        };
      } catch (err) {
        console.error('Query error:', err);
        return reply.status(500).send({ error: 'Database query failed' });
      }
    }
  );

  /**
   * GET /api/products/:asin
   * Full product detail with BSR history and trend analysis
   */
  app.get<{ Params: { asin: string }; Querystring: { country?: string } }>(
    '/api/products/:asin',
    async (request, reply) => {
      const { asin } = request.params;
      const { country = 'US' } = request.query;

      const product = await prisma.product.findFirst({ where: { asin, country } });
      if (!product) return reply.status(404).send({ error: 'Product not found' });

      const history = await prisma.$queryRaw<any[]>`
        SELECT
          time,
          bsr_category,
          estimated_monthly_sales,
          estimated_monthly_revenue,
          price_usd,
          rating,
          review_count
        FROM bsr_snapshots
        WHERE asin = ${asin}
        AND country = ${country}
        AND time >= NOW() - INTERVAL '30 days'
        ORDER BY time ASC
      `;

      const bsrHistory: number[] = history.map((h: SnapshotRow) => h.bsr_category);
      const recentBsr = bsrHistory.slice(-7 * 24);
      const olderBsr = bsrHistory.slice(-14 * 24, -7 * 24);

      const stabilityScore = calculateBsrStabilityScore(bsrHistory);
      const trend = calculateTrend(recentBsr, olderBsr);

      const latestSnapshot = history[history.length - 1];
      const currentEstimate = latestSnapshot
        ? estimateMonthlySales(
            latestSnapshot.bsr_category,
            product.primaryCategory,
            latestSnapshot.price_usd ? parseFloat(latestSnapshot.price_usd) : undefined
          )
        : null;

      const rawPrice = product.priceUsd ? parseFloat(product.priceUsd.toString()) : null;
      const currencyInfo = getCountryCurrency(country);

      return {
        product: {
          asin: product.asin,
          title: product.title,
          brand: product.brand,
          imageUrl: product.imageUrl,
          productUrl: product.productUrl,
          category: product.primaryCategory,
          priceLocal: rawPrice,
          priceUsd: rawPrice != null ? convertToUsd(rawPrice, country) : null,
          priceCurrency: { code: currencyInfo.code, symbol: currencyInfo.symbol },
        },
        analytics: {
          currentBsr: latestSnapshot?.bsr_category,
          estimatedMonthlySales: currentEstimate?.estimatedMonthlySales,
          estimatedMonthlyRevenue: currentEstimate?.estimatedMonthlyRevenue,
          confidenceLevel: currentEstimate?.confidenceLevel,
          confidenceReason: currentEstimate?.confidenceReason,
          stabilityScore,
          trend,
          peakBsr: bsrHistory.length > 0 ? Math.min(...bsrHistory) : null,
          avgBsr: bsrHistory.length > 0
            ? Math.round(bsrHistory.reduce((a: number, b: number) => a + b, 0) / bsrHistory.length)
            : null,
        },
        history: history.map((h: SnapshotRow) => ({
          time: h.time,
          bsr: h.bsr_category,
          estimatedSales: h.estimated_monthly_sales,
          revenue: h.estimated_monthly_revenue
            ? parseFloat(h.estimated_monthly_revenue)
            : null,
        })),
      };
    }
  );

  /**
   * GET /api/categories
   */
  app.get('/api/categories', async () => {
    return Object.entries(CATEGORY_CURVES).map(([key, config]) => ({
      key,
      displayName: config.displayName,
      totalProductsEstimate: config.totalProductsEstimate,
    }));
  });

  /**
   * GET /api/stats
   */
  app.get<{
    Querystring: {
      country?: string;
      category?: string;
    };
  }>('/api/stats', async (request) => {
    const { country, category } = request.query;

    const scopedCountry = country && country !== 'all' ? country : undefined;
    const scopedCategory = category && category !== 'all' ? category : undefined;

    const productWhere: any = {};
    const snapshotWhere: any = {};

    if (scopedCountry) {
      productWhere.country = scopedCountry;
      snapshotWhere.country = scopedCountry;
    }

    if (scopedCategory) {
      productWhere.primaryCategory = scopedCategory;
      snapshotWhere.category = scopedCategory;
    }

    const categoryCountPromise = scopedCategory
      ? Promise.resolve(1)
      : scopedCountry
      ? prisma.bsrSnapshot.groupBy({
          by: ['category'],
          where: snapshotWhere,
        }).then((rows) => rows.length)
      : Promise.resolve(Object.keys(CATEGORY_CURVES).length);

    const [productCount, snapshotCount, lastScrape, categoryCount] = await Promise.all([
      prisma.product.count({ where: productWhere }),
      prisma.bsrSnapshot.count({ where: snapshotWhere }),
      prisma.bsrSnapshot.findFirst({
        where: snapshotWhere,
        orderBy: { time: 'desc' },
        select: { time: true },
      }),
      categoryCountPromise,
    ]);

    return {
      totalProducts: productCount,
      totalSnapshots: snapshotCount,
      lastUpdated: lastScrape?.time ?? null,
      categoriesTracked: categoryCount,
    };
  });

  /**
   * GET /api/scrape-jobs/recent
   * Show recent scrape job statuses
   */
  app.get('/api/scrape-jobs/recent', async () => {
    const jobs = await prisma.$queryRaw<any[]>`
      SELECT * FROM scrape_jobs
      ORDER BY created_at DESC
      LIMIT 50
    `;
    return jobs;
  });

  /**
   * POST /api/admin/calibrate
   * Submit ground truth data for accuracy improvement
   */
  app.post<{
    Body: {
      asin: string;
      category: string;
      actualMonthlySales: number;
      reportedAt: string;
    }
  }>('/api/admin/calibrate', async (request, reply) => {
    const { asin, category, actualMonthlySales, reportedAt } = request.body;

    if (!asin || !category || !actualMonthlySales) {
      return reply.status(400).send({ error: 'Missing required fields' });
    }

    await prisma.calibrationData.create({
      data: {
        asin,
        category,
        actualMonthlySales,
        reportedAt: new Date(reportedAt),
      },
    });

    return { success: true, message: 'Calibration data stored' };
  });
}

function formatProduct(raw: any) {
  const rawPrice = raw.price_usd ? parseFloat(raw.price_usd) : null;
  const country = raw.country || 'US';
  const currencyInfo = getCountryCurrency(country);

  return {
    rank: parseInt(raw.rank),
    asin: raw.asin,
    country,
    title: raw.title,
    brand: raw.brand,
    imageUrl: raw.image_url,
    productUrl: raw.product_url,
    category: raw.category,
    bsrCategory: raw.bsr_category,
    estimatedMonthlySales: raw.estimated_monthly_sales,
    estimatedMonthlyRevenue: raw.estimated_monthly_revenue
      ? parseFloat(raw.estimated_monthly_revenue)
      : null,
    priceLocal: rawPrice,
    priceUsd: rawPrice != null ? convertToUsd(rawPrice, country) : null,
    priceCurrency: { code: currencyInfo.code, symbol: currencyInfo.symbol },
    rating: raw.rating ? parseFloat(raw.rating) : null,
    reviewCount: raw.review_count,
    lastUpdated: raw.time,
  };
}
