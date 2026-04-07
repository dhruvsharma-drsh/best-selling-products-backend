import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import {
  discoverSnapshots,
  scrapeArchivePage,
  ARCHIVE_CATEGORIES,
} from '../../scraper/wayback-scraper.js';

export function registerArchiveRoutes(app: FastifyInstance, prisma: PrismaClient) {

  // ── List all imported snapshot dates with product counts ──
  app.get<{
    Querystring: { category?: string };
  }>('/api/archive/snapshots', async (request) => {
    const { category } = request.query;

    const where: any = {};
    if (category && category !== 'all') where.category = category;

    const snapshots = await prisma.archiveSnapshot.groupBy({
      by: ['snapshotDate', 'category'],
      where,
      _count: { id: true },
      orderBy: { snapshotDate: 'desc' },
    });

    return snapshots.map((s: any) => ({
      date: s.snapshotDate.toISOString().split('T')[0],
      category: s.category,
      productCount: s._count.id,
    }));
  });

  // ── Get products for a specific date/category ──
  app.get<{
    Querystring: {
      date: string;
      category?: string;
      search?: string;
      page?: string;
      limit?: string;
    };
  }>('/api/archive/products', async (request) => {
    const { date, category, search, page = '1', limit = '50' } = request.query;

    if (!date) {
      return { error: 'date query parameter is required (YYYY-MM-DD)' };
    }

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const where: any = {
      snapshotDate: new Date(date),
    };
    if (category && category !== 'all') where.category = category;
    if (search) {
      where.productName = { contains: search, mode: 'insensitive' };
    }

    const [products, total] = await Promise.all([
      prisma.archiveSnapshot.findMany({
        where,
        orderBy: { rank: 'asc' },
        skip,
        take: limitNum,
      }),
      prisma.archiveSnapshot.count({ where }),
    ]);

    return {
      data: products.map((p: any) => ({
        id: p.id,
        asin: p.asin,
        productName: p.productName,
        rank: p.rank,
        category: p.category,
        date: p.snapshotDate.toISOString().split('T')[0],
        rating: p.rating ? Number(p.rating) : null,
        reviewCount: p.reviewCount,
        imageUrl: p.imageUrl,
        archiveUrl: p.archiveUrl,
      })),
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    };
  });

  // ── Discover available Wayback Machine snapshots (CDX query) ──
  app.get<{
    Querystring: {
      category?: string;
      startYear?: string;
      endYear?: string;
      limit?: string;
    };
  }>('/api/archive/available', async (request) => {
    const {
      category = 'electronics',
      startYear,
      endYear,
      limit = '200',
    } = request.query;

    try {
      const snapshots = await discoverSnapshots(
        category,
        startYear ? parseInt(startYear) : undefined,
        endYear ? parseInt(endYear) : undefined,
        Math.min(500, parseInt(limit))
      );

      // Check which ones are already imported
      const importedDates = await prisma.archiveSnapshot.groupBy({
        by: ['snapshotDate'],
        where: { category },
      });

      const importedSet = new Set(
        importedDates.map((d: any) => d.snapshotDate.toISOString().split('T')[0])
      );

      return {
        category,
        totalAvailable: snapshots.length,
        snapshots: snapshots.map((s) => ({
          ...s,
          alreadyImported: importedSet.has(s.date),
        })),
      };
    } catch (err) {
      return { error: (err as Error).message };
    }
  });

  // ── Get rank trend for a specific product across all imported dates ──
  app.get<{
    Params: { asin: string };
    Querystring: { category?: string };
  }>('/api/archive/trends/:asin', async (request) => {
    const { asin } = request.params;
    const { category } = request.query;

    const where: any = { asin };
    if (category && category !== 'all') where.category = category;

    const records = await prisma.archiveSnapshot.findMany({
      where,
      orderBy: { snapshotDate: 'asc' },
      select: {
        snapshotDate: true,
        rank: true,
        category: true,
        productName: true,
        rating: true,
        reviewCount: true,
      },
    });

    return {
      asin,
      productName: records[0]?.productName || 'Unknown',
      dataPoints: records.map((r: any) => ({
        date: r.snapshotDate.toISOString().split('T')[0],
        rank: r.rank,
        category: r.category,
        rating: r.rating ? Number(r.rating) : null,
        reviewCount: r.reviewCount,
      })),
    };
  });

  // ── Trigger import of a specific archive snapshot ──
  app.post<{
    Body: {
      archiveUrl: string;
      category: string;
      date: string;
    };
  }>('/api/archive/import', async (request) => {
    const { archiveUrl, category, date } = request.body;

    if (!archiveUrl || !category || !date) {
      return { error: 'archiveUrl, category, and date are required' };
    }

    // Create import job
    const job = await prisma.archiveImportJob.create({
      data: {
        archiveUrl,
        category,
        snapshotDate: new Date(date),
        status: 'running',
      },
    });

    // Run import in background (don't await)
    runImport(prisma, job.id, archiveUrl, category, date).catch((err) => {
      console.error(`Import job ${job.id} failed:`, err);
    });

    return {
      success: true,
      jobId: job.id,
      message: `Import started for ${category} on ${date}`,
    };
  });

  // ── Bulk import: import multiple snapshots at once ──
  app.post<{
    Body: {
      category: string;
      snapshots: { archiveUrl: string; date: string }[];
    };
  }>('/api/archive/import/bulk', async (request) => {
    const { category, snapshots } = request.body;

    if (!category || !snapshots || snapshots.length === 0) {
      return { error: 'category and snapshots array are required' };
    }

    const jobIds: number[] = [];

    for (const snap of snapshots) {
      const job = await prisma.archiveImportJob.create({
        data: {
          archiveUrl: snap.archiveUrl,
          category,
          snapshotDate: new Date(snap.date),
          status: 'pending',
        },
      });
      jobIds.push(job.id);
    }

    // Process them sequentially in background
    processBulkImport(prisma, jobIds, category).catch((err) => {
      console.error('Bulk import failed:', err);
    });

    return {
      success: true,
      jobIds,
      message: `Queued ${snapshots.length} imports for ${category}`,
    };
  });

  // ── Check import job status ──
  app.get<{
    Querystring: { limit?: string };
  }>('/api/archive/import/status', async (request) => {
    const limit = Math.min(50, parseInt(request.query.limit || '20'));

    const jobs = await prisma.archiveImportJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return jobs.map((j: any) => ({
      id: j.id,
      archiveUrl: j.archiveUrl,
      category: j.category,
      date: j.snapshotDate.toISOString().split('T')[0],
      status: j.status,
      productsFound: j.productsFound,
      errorMessage: j.errorMessage,
      createdAt: j.createdAt.toISOString(),
      completedAt: j.completedAt?.toISOString() || null,
    }));
  });

  // ── List supported archive categories ──
  app.get('/api/archive/categories', async () => {
    return Object.entries(ARCHIVE_CATEGORIES).map(([key, path]) => ({
      key,
      path,
    }));
  });
}

// ── Background import logic ──

async function runImport(
  prisma: PrismaClient,
  jobId: number,
  archiveUrl: string,
  category: string,
  date: string
) {
  try {
    await prisma.archiveImportJob.update({
      where: { id: jobId },
      data: { status: 'running' },
    });

    const products = await scrapeArchivePage(archiveUrl, category);

    // Upsert products into archive_snapshots
    let insertCount = 0;
    for (const product of products) {
      try {
        await prisma.archiveSnapshot.upsert({
          where: {
            asin_category_snapshotDate: {
              asin: product.asin,
              category: product.category,
              snapshotDate: new Date(date),
            },
          },
          update: {
            productName: product.productName,
            rank: product.rank,
            rating: product.rating ?? null,
            reviewCount: product.reviewCount ?? null,
            imageUrl: product.imageUrl ?? null,
            archiveUrl,
          },
          create: {
            asin: product.asin,
            productName: product.productName,
            rank: product.rank,
            category: product.category,
            snapshotDate: new Date(date),
            archiveUrl,
            rating: product.rating ?? null,
            reviewCount: product.reviewCount ?? null,
            imageUrl: product.imageUrl ?? null,
          },
        });
        insertCount++;
      } catch (err) {
        // Skip duplicate or constraint errors
        console.warn(`  Skipping product ${product.asin}: ${(err as Error).message}`);
      }
    }

    await prisma.archiveImportJob.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        productsFound: insertCount,
        completedAt: new Date(),
      },
    });

    console.log(`✅ Import job ${jobId} completed: ${insertCount} products`);
  } catch (err) {
    await prisma.archiveImportJob.update({
      where: { id: jobId },
      data: {
        status: 'failed',
        errorMessage: (err as Error).message,
        completedAt: new Date(),
      },
    });
    console.error(`❌ Import job ${jobId} failed:`, (err as Error).message);
  }
}

async function processBulkImport(
  prisma: PrismaClient,
  jobIds: number[],
  category: string
) {
  for (const jobId of jobIds) {
    const job = await prisma.archiveImportJob.findUnique({ where: { id: jobId } });
    if (!job) continue;

    await runImport(
      prisma,
      job.id,
      job.archiveUrl,
      job.category,
      job.snapshotDate.toISOString().split('T')[0]
    );

    // Rate-limit between imports
    await new Promise((r) => setTimeout(r, 2000));
  }
}
