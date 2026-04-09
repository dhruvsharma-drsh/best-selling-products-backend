import { FastifyInstance } from 'fastify';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  estimateMonthlySales,
  calculateBsrStabilityScore,
  calculateTrend,
} from '../../estimation/sales-estimator.js';
import { CATEGORY_CURVES } from '../../estimation/category-curves.js';
import {
  convertLocalToUsdDetailed,
  convertUsdToLocalDetailed,
  getCountryCurrency,
} from '../../lib/currency-rates.js';

interface SnapshotRow {
  time: Date;
  bsr_category: number;
  estimated_monthly_sales: number | null;
  estimated_monthly_revenue: string | null;
  price_local: string | null;
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
  priceLocal: { toString(): string } | null;
  priceUsd: { toString(): string } | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ProductBsrStats {
  stabilityScore: number | null;
  peakBsr: number | null;
  avgBsr: number | null;
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

function parseNullableDecimal(value: { toString(): string } | string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = parseFloat(value.toString());
  return Number.isFinite(parsed) ? parsed : null;
}

function findLatestHistoryPrice(
  history: SnapshotRow[],
  field: 'price_local' | 'price_usd'
): number | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const parsed = parseNullableDecimal(history[index]?.[field]);
    if (parsed != null) {
      return parsed;
    }
  }

  return null;
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
        priceLocal: p.priceLocal ? parseFloat(p.priceLocal.toString()) : null,
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
              s.price_local,
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

        const asins = results
          .map((result) => result.asin)
          .filter((asin): asin is string => typeof asin === 'string' && asin.length > 0);
        const bsrStatsByAsin = new Map<string, ProductBsrStats>();

        if (asins.length > 0) {
          const historyRows = await prisma.$queryRaw<Array<{ asin: string; bsr_category: number }>>(
            Prisma.sql`
              SELECT asin, bsr_category
              FROM bsr_snapshots
              WHERE country = ${country}
                AND asin IN (${Prisma.join(asins)})
                AND time >= NOW() - INTERVAL '30 days'
              ORDER BY asin ASC, time ASC
            `
          );

          const historyByAsin = new Map<string, number[]>();

          for (const row of historyRows) {
            if (!row.asin || row.bsr_category == null) {
              continue;
            }

            const history = historyByAsin.get(row.asin) ?? [];
            history.push(Number(row.bsr_category));
            historyByAsin.set(row.asin, history);
          }

          for (const asin of asins) {
            const history = historyByAsin.get(asin) ?? [];

            bsrStatsByAsin.set(asin, {
              stabilityScore:
                history.length > 0 ? calculateBsrStabilityScore(history) : null,
              peakBsr: history.length > 0 ? Math.min(...history) : null,
              avgBsr:
                history.length > 0
                  ? Math.round(
                      history.reduce((sum, bsr) => sum + bsr, 0) / history.length
                    )
                  : null,
            });
          }
        }

        const formattedProducts = [];
        for (const result of results) {
          formattedProducts.push(
            await formatProduct(result, bsrStatsByAsin.get(result.asin))
          );
        }

        return {
          data: formattedProducts,
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
          price_local,
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
      const rawLocalPrice = parseNullableDecimal(product.priceLocal);
      const rawUsdPrice = parseNullableDecimal(product.priceUsd);
      const latestSnapshotLocalPrice = parseNullableDecimal(latestSnapshot?.price_local);
      const latestSnapshotUsdPrice = parseNullableDecimal(latestSnapshot?.price_usd);
      const latestAvailableLocalPrice = latestSnapshotLocalPrice ?? findLatestHistoryPrice(history, 'price_local');
      const latestAvailableUsdPrice = latestSnapshotUsdPrice ?? findLatestHistoryPrice(history, 'price_usd');
      let displayLocalPrice =
        rawLocalPrice ??
        latestAvailableLocalPrice ??
        (country === 'US' ? rawUsdPrice ?? latestAvailableUsdPrice : null);
      const currencyInfo = getCountryCurrency(country);
      let displayUsdPrice = rawUsdPrice ?? latestAvailableUsdPrice;
      let priceConversion: {
        usdStatus: 'available' | 'unavailable';
        usdSource: 'stored_product' | 'stored_snapshot' | 'live_api' | 'missing_price' | 'conversion_error';
        exchangeRate: number | null;
        message: string | null;
      } = displayUsdPrice != null
        ? {
            usdStatus: 'available',
            usdSource: rawUsdPrice != null ? 'stored_product' : 'stored_snapshot',
            exchangeRate: null,
            message: null,
          }
        : {
            usdStatus: 'unavailable',
            usdSource: displayLocalPrice == null ? 'missing_price' : 'conversion_error',
            exchangeRate: null,
            message: displayLocalPrice == null ? 'Local price is unavailable for this product.' : null,
          };

      if (displayUsdPrice == null && displayLocalPrice != null) {
        try {
          const conversion = await convertLocalToUsdDetailed(displayLocalPrice, country);
          if (conversion.amount != null) {
            displayUsdPrice = conversion.amount;
            priceConversion = {
              usdStatus: 'available',
              usdSource: 'live_api',
              exchangeRate: conversion.rate,
              message: null,
            };

            const updateData: Record<string, number> = {};
            if (rawLocalPrice == null) {
              updateData.priceLocal = displayLocalPrice;
            }
            if (rawUsdPrice == null) {
              updateData.priceUsd = conversion.amount;
            }

            if (Object.keys(updateData).length > 0) {
              await prisma.product.update({
                where: {
                  asin_country: { asin, country },
                },
                data: updateData,
              }).catch((err) => {
                console.warn(`Failed to cache converted price for ${asin}/${country}:`, err);
              });
            }
          } else {
            priceConversion = {
              usdStatus: 'unavailable',
              usdSource: 'conversion_error',
              exchangeRate: null,
              message: 'USD conversion did not return a price.',
            };
          }
        } catch (error) {
          const rawMessage = error instanceof Error ? error.message : 'USD conversion failed.';
          const message = rawMessage.includes('CURRENCY_API_URL')
            ? 'USD conversion is unavailable until the currency API is configured in the backend environment.'
            : rawMessage.includes('USD rate')
              ? 'The currency API response did not include a USD exchange rate.'
              : rawMessage;
          priceConversion = {
            usdStatus: 'unavailable',
            usdSource: 'conversion_error',
            exchangeRate: null,
            message,
          };
        }
      }

      if (displayLocalPrice == null && displayUsdPrice != null && currencyInfo.code !== 'USD') {
        try {
          const reverseConversion = await convertUsdToLocalDetailed(displayUsdPrice, country);
          if (reverseConversion.amount != null) {
            displayLocalPrice = reverseConversion.amount;
          }
        } catch (error) {
          console.warn(
            `Failed to derive local price from USD for ${asin}/${country}:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }

      const currentEstimate = latestSnapshot
        ? estimateMonthlySales(
            latestSnapshot.bsr_category,
            product.primaryCategory,
            latestSnapshotUsdPrice ?? displayUsdPrice ?? undefined
          )
        : null;

      return {
        product: {
          asin: product.asin,
          title: product.title,
          brand: product.brand,
          imageUrl: product.imageUrl,
          productUrl: product.productUrl,
          category: product.primaryCategory,
          priceLocal: displayLocalPrice,
          priceUsd: displayUsdPrice,
          priceCurrency: {
            code: currencyInfo.code,
            symbol: currencyInfo.symbol,
            locale: currencyInfo.locale,
          },
          priceConversion,
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

async function formatProduct(raw: any, bsrStats?: ProductBsrStats) {
  const rawLocalPrice = raw.price_local ? parseFloat(raw.price_local) : null;
  const rawUsdPrice = raw.price_usd ? parseFloat(raw.price_usd) : null;
  const country = raw.country || 'US';
  const currencyInfo = getCountryCurrency(country);
  let displayLocalPrice =
    rawLocalPrice ?? (currencyInfo.code === 'USD' ? rawUsdPrice : null);

  if (displayLocalPrice == null && rawUsdPrice != null && currencyInfo.code !== 'USD') {
    try {
      const reverseConversion = await convertUsdToLocalDetailed(rawUsdPrice, country);
      if (reverseConversion.amount != null) {
        displayLocalPrice = reverseConversion.amount;
      }
    } catch (error) {
      console.warn(
        `Failed to derive local price for list view ${raw.asin}/${country}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

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
    stabilityScore: bsrStats?.stabilityScore ?? null,
    peakBsr: bsrStats?.peakBsr ?? null,
    avgBsr: bsrStats?.avgBsr ?? null,
    priceLocal: displayLocalPrice,
    priceUsd: rawUsdPrice,
    priceCurrency: {
      code: currencyInfo.code,
      symbol: currencyInfo.symbol,
      locale: currencyInfo.locale,
    },
    rating: raw.rating ? parseFloat(raw.rating) : null,
    reviewCount: raw.review_count,
    lastUpdated: raw.time,
  };
}
