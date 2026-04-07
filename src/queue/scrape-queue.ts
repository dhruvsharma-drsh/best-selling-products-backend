import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { AmazonScraper, ScrapeCancelledError } from '../scraper/amazon-scraper.js';
import { estimateMonthlySales } from '../estimation/sales-estimator.js';
import { PrismaClient } from '@prisma/client';
import { CATEGORY_KEYS } from '../estimation/category-curves.js';

const useTls = process.env.REDIS_TLS === 'true';

const connection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  ...(useTls ? { tls: {} } : {}),
});

const BULK_QUEUE_NAME = 'amazon-scrape-bulk-v2';
const REALTIME_QUEUE_NAME = 'amazon-scrape-realtime-v2';
const LEGACY_QUEUE_NAMES = ['amazon-scrape'] as const;

export type ScrapeQueueKind = 'bulk' | 'realtime';

export interface ScrapeJobData {
  categoryKey: string;
  country: string;
  maxProducts?: number;
}

export const bulkScrapeQueue = new Queue<ScrapeJobData>(BULK_QUEUE_NAME, { connection });
export const realtimeScrapeQueue = new Queue<ScrapeJobData>(REALTIME_QUEUE_NAME, { connection });

const SCRAPE_PRIORITIES = {
  realtimeSync: 0,
  manualBulkAll: 5,
  scheduledHigh: 10,
  scheduledNormal: 20,
} as const;

interface TriggerScrapeOptions {
  kind?: ScrapeQueueKind;
  priority?: number;
  lifo?: boolean;
  replaceWaiting?: boolean;
}

interface QueueControlState {
  stopRequested: boolean;
  activeAbortController: AbortController | null;
  activeJobId: string | null;
}

const queueControlState: Record<ScrapeQueueKind, QueueControlState> = {
  bulk: {
    stopRequested: false,
    activeAbortController: null,
    activeJobId: null,
  },
  realtime: {
    stopRequested: false,
    activeAbortController: null,
    activeJobId: null,
  },
};

function getQueue(kind: ScrapeQueueKind): Queue<ScrapeJobData> {
  return kind === 'realtime' ? realtimeScrapeQueue : bulkScrapeQueue;
}

async function clearQueuedJobs(queue: Queue<ScrapeJobData>): Promise<void> {
  const queuedJobs = await queue.getJobs(['waiting', 'prioritized', 'delayed']);
  for (const job of queuedJobs) {
    await job.remove();
  }
}

function resetQueueControl(kind: ScrapeQueueKind): void {
  queueControlState[kind].stopRequested = false;
  queueControlState[kind].activeAbortController = null;
  queueControlState[kind].activeJobId = null;
}

export async function stopScrapes(kind: ScrapeQueueKind): Promise<{
  kind: ScrapeQueueKind;
  activeJobId: string | null;
  removedWaitingJobs: number;
}> {
  const queue = getQueue(kind);
  const control = queueControlState[kind];
  control.stopRequested = true;

  const queuedJobs = await queue.getJobs(['waiting', 'prioritized', 'delayed']);
  for (const job of queuedJobs) {
    await job.remove();
  }

  control.activeAbortController?.abort();

  if (!control.activeJobId) {
    resetQueueControl(kind);
  }

  return {
    kind,
    activeJobId: control.activeJobId,
    removedWaitingJobs: queuedJobs.length,
  };
}

export async function quarantineLegacyQueues(): Promise<void> {
  for (const queueName of LEGACY_QUEUE_NAMES) {
    const legacyQueue = new Queue<ScrapeJobData>(queueName, { connection });

    try {
      await legacyQueue.pause();
      const queuedJobs = await legacyQueue.getJobs(['waiting', 'prioritized', 'delayed']);

      for (const job of queuedJobs) {
        await job.remove();
      }

      if (queuedJobs.length > 0) {
        console.log(`Quarantined legacy queue ${queueName} and removed ${queuedJobs.length} waiting jobs`);
      }
    } finally {
      await legacyQueue.close();
    }
  }
}

async function enqueueScrapeJob(
  kind: ScrapeQueueKind,
  queue: Queue<ScrapeJobData>,
  categoryKey: string,
  country: string,
  maxProducts: number,
  options: TriggerScrapeOptions = {}
): Promise<string> {
  queueControlState[kind].stopRequested = false;

  if (options.replaceWaiting) {
    await clearQueuedJobs(queue);
  }

  const job = await queue.add(
    `scrape-${categoryKey}-manual`,
    { categoryKey, country: country.toUpperCase(), maxProducts },
    {
      priority: options.priority ?? SCRAPE_PRIORITIES.realtimeSync,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      lifo: options.lifo ?? false,
    }
  );

  return job.id ?? 'unknown';
}

/**
 * Schedule all categories to be scraped on recurring intervals.
 */
export async function scheduleAllCategories(): Promise<void> {
  const highPriority = ['electronics', 'kitchen', 'beauty', 'toys', 'clothing', 'health'];
  const normalPriority = CATEGORY_KEYS.filter(k => !highPriority.includes(k));

  const repeatableJobs = await bulkScrapeQueue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    await bulkScrapeQueue.removeRepeatableByKey(job.key);
  }

  for (const categoryKey of highPriority) {
    await bulkScrapeQueue.add(
      `scrape-${categoryKey}`,
      { categoryKey, country: 'US', maxProducts: 100 },
      {
        repeat: { every: 60 * 60 * 1000 },
        priority: SCRAPE_PRIORITIES.scheduledHigh,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      }
    );
  }

  for (const categoryKey of normalPriority) {
    await bulkScrapeQueue.add(
      `scrape-${categoryKey}`,
      { categoryKey, country: 'US', maxProducts: 50 },
      {
        repeat: { every: 6 * 60 * 60 * 1000 },
        priority: SCRAPE_PRIORITIES.scheduledNormal,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      }
    );
  }

  console.log(`Scheduled ${CATEGORY_KEYS.length} categories for recurring bulk scraping`);
}

/**
 * Add a one-off scrape job for a single category.
 * By default this uses the realtime queue so a user-triggered sync only processes
 * the most recent requested category/country pair.
 */
export async function triggerCategoryScrape(
  categoryKey: string,
  country: string = 'US',
  maxProducts: number = 100,
  options: TriggerScrapeOptions = {}
): Promise<string> {
  const kind = options.kind ?? 'realtime';
  return enqueueScrapeJob(
    kind,
    getQueue(kind),
    categoryKey,
    country,
    maxProducts,
    {
      priority: options.priority ?? SCRAPE_PRIORITIES.realtimeSync,
      lifo: options.lifo ?? true,
      replaceWaiting: options.replaceWaiting ?? kind === 'realtime',
    }
  );
}

/**
 * Trigger one-off scrape for all categories.
 */
export async function triggerAllScrapes(country: string = 'US'): Promise<string[]> {
  const jobIds: string[] = [];
  for (const categoryKey of CATEGORY_KEYS) {
    const jobId = await enqueueScrapeJob(
      'bulk',
      bulkScrapeQueue,
      categoryKey,
      country,
      100,
      {
        priority: SCRAPE_PRIORITIES.manualBulkAll,
      }
    );
    jobIds.push(jobId);
  }
  return jobIds;
}

async function processScrapeJob(
  prisma: PrismaClient,
  scraper: AmazonScraper,
  job: Job<ScrapeJobData>,
  queueKind: ScrapeQueueKind
) {
  const { categoryKey, country = 'US', maxProducts = 100 } = job.data;
  const control = queueControlState[queueKind];
  control.activeJobId = job.id ?? null;
  control.stopRequested = false;
  let savedCount = 0;

  const scrapeJobRecord = await prisma.scrapeJob.create({
    data: {
      jobType: 'bestsellers_category',
      categoryUrl: categoryKey,
      country,
      status: 'running',
      startedAt: new Date(),
    },
  });

  console.log(`[${queueKind}] Starting scrape: ${categoryKey} (${maxProducts} products) for ${country}`);
  const startTime = Date.now();

  try {
    const scrapedProducts = await scraper.scrapeBestSellersCategory(categoryKey, country, maxProducts, {
      shouldStop: () => control.stopRequested,
      setAbortController: (controller) => {
        control.activeAbortController = controller;
      },
    });
    const timestamp = new Date();

    for (const product of scrapedProducts) {
      if (control.stopRequested) {
        throw new ScrapeCancelledError();
      }

      try {
        const estimate = estimateMonthlySales(
          product.bsrCategory,
          product.category,
          product.priceUsd
        );

        await prisma.product.upsert({
          where: {
            asin_country: {
              asin: product.asin,
              country,
            }
          },
          create: {
            asin: product.asin,
            country,
            title: product.title,
            brand: product.brand,
            imageUrl: product.imageUrl,
            productUrl: product.productUrl,
            primaryCategory: product.category,
            subcategory: product.subcategory,
            priceUsd: product.priceUsd,
          },
          update: {
            title: product.title,
            brand: product.brand,
            imageUrl: product.imageUrl,
            priceUsd: product.priceUsd,
            updatedAt: new Date(),
          },
        });

        await prisma.$executeRaw`
          INSERT INTO bsr_snapshots (
            time, asin, country, bsr_category, category,
            review_count, rating, price_usd,
            estimated_monthly_sales, estimated_monthly_revenue
          ) VALUES (
            ${timestamp}, ${product.asin}, ${country}, ${product.bsrCategory},
            ${product.category}, ${product.reviewCount ?? null},
            ${product.rating ?? null}, ${product.priceUsd ?? null},
            ${estimate.estimatedMonthlySales},
            ${estimate.estimatedMonthlyRevenue}
          )
          ON CONFLICT DO NOTHING
        `;

        savedCount++;
      } catch (err) {
        console.error(`Failed to save product ${product.asin}:`, err);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${queueKind}] Completed ${categoryKey}: ${savedCount}/${scrapedProducts.length} saved in ${duration}s`);

    await prisma.scrapeJob.update({
      where: { id: scrapeJobRecord.id },
      data: {
        status: 'completed',
        productsFound: savedCount,
        completedAt: new Date(),
      },
    });

    return { categoryKey, saved: savedCount, duration, queueKind };
  } catch (err) {
    if (err instanceof ScrapeCancelledError) {
      await prisma.scrapeJob.update({
        where: { id: scrapeJobRecord.id },
        data: {
          status: 'cancelled',
          productsFound: savedCount,
          errorMessage: err.message,
          completedAt: new Date(),
        },
      });

      console.log(`[${queueKind}] Cancelled scrape: ${categoryKey} for ${country}`);
      return { categoryKey, cancelled: true, queueKind };
    }

    const errorMsg = err instanceof Error ? err.message : String(err);

    await prisma.scrapeJob.update({
      where: { id: scrapeJobRecord.id },
      data: {
        status: 'failed',
        errorMessage: errorMsg,
        completedAt: new Date(),
      },
    });

    throw err;
  } finally {
    resetQueueControl(queueKind);
  }
}

export function createScrapeWorker(prisma: PrismaClient, queueKind: ScrapeQueueKind): Worker<ScrapeJobData> {
  const scraper = new AmazonScraper();
  let scraperInitialized = false;
  const queue = getQueue(queueKind);

  return new Worker<ScrapeJobData>(
    queue.name,
    async (job: Job<ScrapeJobData>) => {
      if (!scraperInitialized) {
        await scraper.init();
        scraperInitialized = true;
      }

      return processScrapeJob(prisma, scraper, job, queueKind);
    },
    {
      connection,
      concurrency: 1,
      limiter: { max: 1, duration: 10000 },
    }
  );
}
