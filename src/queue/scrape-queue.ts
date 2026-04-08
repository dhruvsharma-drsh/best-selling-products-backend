import { config } from '../config/env.js';
import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import {
  AmazonScraper,
  ScrapeCancelledError,
  SUPPORTED_COUNTRIES,
} from '../scraper/amazon-scraper.js';
import { estimateMonthlySales } from '../estimation/sales-estimator.js';
import { PrismaClient } from '@prisma/client';
import { CATEGORY_KEYS } from '../estimation/category-curves.js';
import { DEFAULT_PRODUCT_LIMIT, SUPPORTED_COUNTRY_CONFIGS } from '../config/sync-config.js';
import { convertLocalToUsd } from '../lib/currency-rates.js';

const connection = config.redis.url
  ? new Redis(config.redis.url, {
      maxRetriesPerRequest: null,
    })
  : new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      maxRetriesPerRequest: null,
      ...(config.redis.tls ? { tls: {} } : {}),
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
const bulkQueueEvents = new QueueEvents(BULK_QUEUE_NAME, { connection });

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

interface BulkJobInput {
  categoryKey: string;
  country: string;
  maxProducts: number;
  priority?: number;
}

interface QueueControlState {
  stopRequested: boolean;
  activeAbortController: AbortController | null;
  activeJobId: string | null;
}

interface SequentialCountryProgress {
  country: string;
  status: 'fetching' | 'completed';
  completedCategories: number;
  totalCategories: number;
  failedCategories: number;
}

interface SequentialSyncProgressSnapshot {
  runId: string;
  startedAt: string;
  isFetching: boolean;
  status: 'idle' | 'running' | 'completed' | 'completed_with_issues' | 'stopped';
  totalCountries: number;
  totalCategoriesPerCountry: number;
  totalJobs: number;
  startedJobs: number;
  finishedJobs: number;
  productsFound: number;
  currentCountry: string | null;
  currentCategory: string | null;
  completedCountries: string[];
  countriesStarted: number;
  countryProgress: SequentialCountryProgress[];
  statusBreakdown: Record<string, number>;
  recentJobs: Array<{
    id: number | string;
    country: string;
    category: string;
    status: string;
    productsFound: number;
    errorMessage: string | null;
    createdAt: string;
    completedAt: string | null;
  }>;
  errors: Array<{
    country: string;
    category: string;
    attempt: number;
    message: string;
    at: string;
  }>;
}

let sequentialSyncProgress: SequentialSyncProgressSnapshot | null = null;

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

function normalizeCountry(country: string): string {
  return (country || 'US').trim().toUpperCase();
}

function createRunId(): string {
  return `seq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildOrderedCountries(
  priorityCountry: string,
  selectedCountries?: string[],
  includeRemainingCountries: boolean = true
): string[] {
  const normalizedPriority = normalizeCountry(priorityCountry);
  const selectedNormalized = (selectedCountries ?? [])
    .map((code) => normalizeCountry(code))
    .filter((code, idx, arr) => arr.indexOf(code) === idx)
    .filter((code) => SUPPORTED_COUNTRIES.includes(code as any));

  const selectedFirst = selectedNormalized.length > 0 ? selectedNormalized : [normalizedPriority];
  const orderedSelected = selectedFirst.includes(normalizedPriority)
    ? [normalizedPriority, ...selectedFirst.filter((code) => code !== normalizedPriority)]
    : selectedFirst;

  if (!includeRemainingCountries) {
    return orderedSelected;
  }

  return [...orderedSelected, ...SUPPORTED_COUNTRIES.filter((country) => !orderedSelected.includes(country))];
}

function ensureRunActive(runId: string): SequentialSyncProgressSnapshot {
  if (!sequentialSyncProgress || sequentialSyncProgress.runId !== runId) {
    throw new Error('Global sequential sync run is no longer active.');
  }

  return sequentialSyncProgress;
}

function setRecentJob(
  run: SequentialSyncProgressSnapshot,
  job: SequentialSyncProgressSnapshot['recentJobs'][number]
): void {
  run.recentJobs = [job, ...run.recentJobs].slice(0, 12);
}

export function getSequentialSyncProgress(since?: string): SequentialSyncProgressSnapshot | null {
  if (!sequentialSyncProgress) return null;
  if (since && sequentialSyncProgress.startedAt < since) return null;
  return sequentialSyncProgress;
}

async function clearQueuedJobs(queue: Queue<ScrapeJobData>): Promise<number> {
  const counts = await queue.getJobCounts('waiting', 'paused', 'prioritized', 'delayed');
  const queuedJobCount = Object.values(counts).reduce((total, count) => total + count, 0);

  if (queuedJobCount > 0) {
    // BullMQ drain clears queued work atomically without per-job lock conflicts.
    await queue.drain(true);
  }

  return queuedJobCount;
}

async function waitForActiveJobToSettle(
  kind: ScrapeQueueKind,
  timeoutMs: number = 30000
): Promise<boolean> {
  const startedAt = Date.now();

  while (queueControlState[kind].activeJobId && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return queueControlState[kind].activeJobId === null;
}

async function enqueueScrapeJobsBulk(
  kind: ScrapeQueueKind,
  jobs: BulkJobInput[],
  options: TriggerScrapeOptions = {}
): Promise<string[]> {
  const queue = getQueue(kind);
  queueControlState[kind].stopRequested = false;

  if (options.replaceWaiting) {
    await clearQueuedJobs(queue);
  }

  const addedJobs = await queue.addBulk(
    jobs.map((job) => ({
      name: `scrape-${job.categoryKey}-manual`,
      data: {
        categoryKey: job.categoryKey,
        country: job.country.toUpperCase(),
        maxProducts: job.maxProducts,
      },
      opts: {
        priority: job.priority ?? options.priority ?? SCRAPE_PRIORITIES.manualBulkAll,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        lifo: options.lifo ?? false,
      },
    }))
  );

  return addedJobs.map((job) => job.id ?? 'unknown');
}

function resetQueueControl(kind: ScrapeQueueKind): void {
  queueControlState[kind].stopRequested = false;
  queueControlState[kind].activeAbortController = null;
  queueControlState[kind].activeJobId = null;
}

export async function stopScrapes(kind: ScrapeQueueKind): Promise<{
  kind: ScrapeQueueKind;
  activeJobId: string | null;
  activeJobStopped: boolean;
  removedWaitingJobs: number;
}> {
  const queue = getQueue(kind);
  const control = queueControlState[kind];
  await queue.pause();
  control.stopRequested = true;
  const activeJobId = control.activeJobId;

  control.activeAbortController?.abort();
  const activeJobStopped = await waitForActiveJobToSettle(kind);
  if (kind === 'bulk' && sequentialSyncProgress?.isFetching) {
    sequentialSyncProgress.isFetching = false;
    sequentialSyncProgress.status = 'stopped';
    sequentialSyncProgress.currentCategory = null;
    sequentialSyncProgress.currentCountry = null;
  }

  if (activeJobId && !activeJobStopped) {
    await queue.resume();
    throw new Error(
      `Timed out waiting for the active ${kind} scrape (${activeJobId}) to stop. Please try again in a few seconds.`
    );
  }

  const removedWaitingJobs = await clearQueuedJobs(queue);

  resetQueueControl(kind);
  await queue.resume();

  return {
    kind,
    activeJobId,
    activeJobStopped,
    removedWaitingJobs,
  };
}

export async function resetBulkScrapes(): Promise<{
  activeJobId: string | null;
  activeJobStopped: boolean;
  removedWaitingJobs: number;
}> {
  const result = await stopScrapes('bulk');
  return {
    activeJobId: result.activeJobId,
    activeJobStopped: result.activeJobStopped,
    removedWaitingJobs: result.removedWaitingJobs,
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
  maxProducts: number = DEFAULT_PRODUCT_LIMIT,
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
export async function triggerAllScrapes(
  country: string = 'US',
  maxProducts: number = DEFAULT_PRODUCT_LIMIT
): Promise<string[]> {
  return enqueueScrapeJobsBulk(
    'bulk',
    CATEGORY_KEYS.map((categoryKey) => ({
      categoryKey,
      country,
      maxProducts,
    })),
    {
      priority: SCRAPE_PRIORITIES.manualBulkAll,
    }
  );
}

/**
 * Trigger one-off scrape for every supported country and category.
 */
export async function triggerAllCountriesScrapes(
  priorityCountry: string = 'US',
  maxProducts: number = DEFAULT_PRODUCT_LIMIT,
  selectedCountries?: string[],
  includeRemainingCountries: boolean = true
): Promise<string[]> {
  if (sequentialSyncProgress?.isFetching) {
    throw new Error('A global sync run is already active. Please wait for completion or stop it first.');
  }

  const orderedCountries = buildOrderedCountries(priorityCountry, selectedCountries, includeRemainingCountries);
  const countryConfigMap = new Map(SUPPORTED_COUNTRY_CONFIGS.map((entry) => [entry.code, entry]));
  const runId = createRunId();
  const startedAt = new Date().toISOString();
  const countryProgress = orderedCountries.map((country) => ({
    country,
    status: 'fetching' as const,
    completedCategories: 0,
    totalCategories: CATEGORY_KEYS.length,
    failedCategories: 0,
  }));

  sequentialSyncProgress = {
    runId,
    startedAt,
    isFetching: true,
    status: 'running',
    totalCountries: orderedCountries.length,
    totalCategoriesPerCountry: CATEGORY_KEYS.length,
    totalJobs: orderedCountries.length * CATEGORY_KEYS.length,
    startedJobs: 0,
    finishedJobs: 0,
    productsFound: 0,
    currentCountry: orderedCountries[0] ?? null,
    currentCategory: null,
    completedCountries: [],
    countriesStarted: 0,
    countryProgress,
    statusBreakdown: {
      queued: orderedCountries.length * CATEGORY_KEYS.length,
      running: 0,
      completed: 0,
      failed_then_continued: 0,
      cancelled: 0,
    },
    recentJobs: [],
    errors: [],
  };

  const runInBackground = async () => {
    const MAX_CATEGORY_RETRIES = 2;

    for (const country of orderedCountries) {
      let run = ensureRunActive(runId);
      if (!run.isFetching) break;

      run.currentCountry = country;
      run.currentCategory = null;
      run.countriesStarted += 1;
      const countryState = run.countryProgress.find((item) => item.country === country);

      for (const categoryKey of CATEGORY_KEYS) {
        run = ensureRunActive(runId);
        if (!run.isFetching) break;

        run.currentCategory = categoryKey;
        run.startedJobs += 1;
        run.statusBreakdown.queued = Math.max(0, run.statusBreakdown.queued - 1);
        run.statusBreakdown.running += 1;
        const countryConfig = countryConfigMap.get(country);
        if (countryConfig?.platform === 'local_fallback') {
          run.finishedJobs += 1;
          run.statusBreakdown.running = Math.max(0, run.statusBreakdown.running - 1);
          run.statusBreakdown.failed_then_continued += 1;
          const fallbackError = `${country} uses local fallback; Amazon scraping is not available for this country in the current scraper pipeline.`;
          setRecentJob(run, {
            id: `${country}-${categoryKey}-fallback`,
            country,
            category: categoryKey,
            status: 'failed_then_continued',
            productsFound: 0,
            errorMessage: fallbackError,
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          });
          run.errors.push({
            country,
            category: categoryKey,
            attempt: 1,
            message: fallbackError,
            at: new Date().toISOString(),
          });
          if (countryState) {
            countryState.completedCategories += 1;
            countryState.failedCategories += 1;
          }
          continue;
        }

        let attempt = 0;
        let completed = false;
        while (attempt <= MAX_CATEGORY_RETRIES && !completed) {
          attempt += 1;
          const startedJobAt = new Date().toISOString();
          try {
            const jobId = await enqueueScrapeJob(
              'bulk',
              bulkScrapeQueue,
              categoryKey,
              country,
              maxProducts,
              {
                priority: SCRAPE_PRIORITIES.manualBulkAll,
                lifo: false,
                replaceWaiting: false,
              }
            );
            const job = await bulkScrapeQueue.getJob(jobId);
            if (!job) {
              throw new Error('Queued job was not found');
            }
            const result = await job.waitUntilFinished(bulkQueueEvents);
            const savedCount = typeof (result as any)?.saved === 'number' ? (result as any).saved : 0;

            run = ensureRunActive(runId);
            run.productsFound += savedCount;
            run.finishedJobs += 1;
            run.statusBreakdown.running = Math.max(0, run.statusBreakdown.running - 1);
            run.statusBreakdown.completed += 1;
            setRecentJob(run, {
              id: String(jobId),
              country,
              category: categoryKey,
              status: 'completed',
              productsFound: savedCount,
              errorMessage: null,
              createdAt: startedJobAt,
              completedAt: new Date().toISOString(),
            });
            countryState && (countryState.completedCategories += 1);
            completed = true;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            run = ensureRunActive(runId);
            run.errors.push({
              country,
              category: categoryKey,
              attempt,
              message,
              at: new Date().toISOString(),
            });

            if (attempt > MAX_CATEGORY_RETRIES) {
              run.finishedJobs += 1;
              run.statusBreakdown.running = Math.max(0, run.statusBreakdown.running - 1);
              run.statusBreakdown.failed_then_continued += 1;
              setRecentJob(run, {
                id: `${country}-${categoryKey}-${attempt}`,
                country,
                category: categoryKey,
                status: 'failed_then_continued',
                productsFound: 0,
                errorMessage: message,
                createdAt: startedJobAt,
                completedAt: new Date().toISOString(),
              });
              if (countryState) {
                countryState.completedCategories += 1;
                countryState.failedCategories += 1;
              }
            }
          }
        }
      }

      run = ensureRunActive(runId);
      run.currentCategory = null;
      if (countryState) {
        countryState.status = 'completed';
      }
      run.completedCountries.push(country);
    }

    const run = ensureRunActive(runId);
    run.isFetching = false;
    run.currentCountry = null;
    run.currentCategory = null;
    run.statusBreakdown.running = 0;
    run.status = run.statusBreakdown.failed_then_continued > 0 ? 'completed_with_issues' : 'completed';
  };

  void runInBackground().catch((err) => {
    if (!sequentialSyncProgress || sequentialSyncProgress.runId !== runId) return;
    sequentialSyncProgress.isFetching = false;
    sequentialSyncProgress.currentCountry = null;
    sequentialSyncProgress.currentCategory = null;
    sequentialSyncProgress.status = 'completed_with_issues';
    sequentialSyncProgress.errors.push({
      country: sequentialSyncProgress.currentCountry ?? 'unknown',
      category: sequentialSyncProgress.currentCategory ?? 'unknown',
      attempt: 1,
      message: err instanceof Error ? err.message : String(err),
      at: new Date().toISOString(),
    });
  });

  return [runId];
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
        const localPrice = product.priceUsd;
        const convertedUsdPrice = localPrice != null
          ? await convertLocalToUsd(localPrice, country).catch(() => null)
          : null;
        const estimate = estimateMonthlySales(
          product.bsrCategory,
          product.category,
          convertedUsdPrice ?? undefined
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
            priceLocal: localPrice,
            priceUsd: convertedUsdPrice,
          },
          update: {
            title: product.title,
            brand: product.brand,
            imageUrl: product.imageUrl,
            updatedAt: new Date(),
            ...(localPrice != null ? { priceLocal: localPrice } : {}),
            ...(convertedUsdPrice != null ? { priceUsd: convertedUsdPrice } : {}),
          },
        });

        await prisma.$executeRaw`
          INSERT INTO bsr_snapshots (
            time, asin, country, bsr_category, category,
            review_count, rating, price_local, price_usd,
            estimated_monthly_sales, estimated_monthly_revenue
          ) VALUES (
            ${timestamp}, ${product.asin}, ${country}, ${product.bsrCategory},
            ${product.category}, ${product.reviewCount ?? null},
            ${product.rating ?? null}, ${localPrice ?? null}, ${convertedUsdPrice ?? null},
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
