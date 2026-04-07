import * as cheerio from 'cheerio';
import { CATEGORY_CURVES } from '../estimation/category-curves.js';

export interface ScrapedProduct {
  asin: string;
  country: string;
  title: string;
  brand?: string;
  imageUrl?: string;
  productUrl: string;
  bsrCategory: number;
  category: string;
  subcategory?: string;
  priceUsd?: number;
  reviewCount?: number;
  rating?: number;
}

export interface ScrapeRunOptions {
  shouldStop?: () => boolean;
  setAbortController?: (controller: AbortController | null) => void;
}

export class ScrapeCancelledError extends Error {
  constructor(message: string = 'Scrape stopped by user') {
    super(message);
    this.name = 'ScrapeCancelledError';
  }
}

export const COUNTRY_DOMAINS: Record<string, string> = {
  US: 'amazon.com',
  UK: 'amazon.co.uk',
  CA: 'amazon.ca',
  DE: 'amazon.de',
  FR: 'amazon.fr',
  IT: 'amazon.it',
  ES: 'amazon.es',
  IN: 'amazon.in',
  JP: 'amazon.co.jp',
  AU: 'amazon.com.au',
  AE: 'amazon.ae',
};

// Country-specific Accept-Language headers to avoid geo-redirect issues
const COUNTRY_LANG: Record<string, string> = {
  US: 'en-US,en;q=0.9',
  UK: 'en-GB,en;q=0.9',
  CA: 'en-CA,en;q=0.9',
  DE: 'de-DE,de;q=0.9,en;q=0.5',
  FR: 'fr-FR,fr;q=0.9,en;q=0.5',
  IT: 'it-IT,it;q=0.9,en;q=0.5',
  ES: 'es-ES,es;q=0.9,en;q=0.5',
  IN: 'en-IN,en;q=0.9',
  JP: 'ja-JP,ja;q=0.9,en;q=0.5',
  AU: 'en-AU,en;q=0.9',
  AE: 'en-AE,ar;q=0.9,en;q=0.5',
};

/**
 * Country-specific bestseller category paths.
 *
 * IMPORTANT: Amazon uses STANDARDIZED ENGLISH slugs for /gp/bestsellers/ URLs
 * across virtually ALL international domains. Verified on JP (live page) and FR (search).
 * Localized slugs (spielzeug, cuisine, cucina, etc.) do NOT work and cause 0-product errors.
 *
 * Special cases:
 *   - US uses a few unique slugs: 'toys-and-games', 'sporting-goods', 'home-garden'
 *   - JP 'home' category maps to 'kitchen' (ホーム＆キッチン)
 *   - DE 'electronics' uses 'ce-de' (Consumer Electronics Deutschland)
 *   - IN has a few unique ones: 'car-motorbike', 'sports-fitness-and-outdoors'
 *
 * If a country is not listed, we fall back to the node ID approach.
 */
const COUNTRY_CATEGORY_PATHS: Record<string, Record<string, string>> = {
  electronics: {
    US: 'electronics', UK: 'electronics', CA: 'electronics',
    DE: 'ce-de', FR: 'electronics', IT: 'electronics',
    ES: 'electronics', IN: 'electronics', JP: 'electronics', AU: 'electronics',
    AE: 'electronics',
  },
  kitchen: {
    US: 'kitchen', UK: 'kitchen', CA: 'kitchen',
    DE: 'kitchen', FR: 'kitchen', IT: 'kitchen',
    ES: 'kitchen', IN: 'kitchen', JP: 'kitchen', AU: 'kitchen',
    AE: 'kitchen',
  },
  beauty: {
    US: 'beauty', UK: 'beauty', CA: 'beauty',
    DE: 'beauty', FR: 'beauty', IT: 'beauty',
    ES: 'beauty', IN: 'beauty', JP: 'beauty', AU: 'beauty',
    AE: 'beauty',
  },
  toys: {
    US: 'toys-and-games', UK: 'toys', CA: 'toys',
    DE: 'toys', FR: 'toys', IT: 'toys',
    ES: 'toys', IN: 'toys', JP: 'toys', AU: 'toys',
    AE: 'toys',
  },
  sports: {
    US: 'sporting-goods', UK: 'sports', CA: 'sports',
    DE: 'sports', FR: 'sports', IT: 'sports',
    ES: 'sports', IN: 'sports', JP: 'sports', AU: 'sports',
    AE: 'sporting-goods',
  },
  clothing: {
    US: 'fashion', UK: 'fashion', CA: 'fashion',
    DE: 'fashion', FR: 'fashion', IT: 'fashion',
    ES: 'fashion', IN: 'fashion', JP: 'fashion', AU: 'fashion',
    AE: 'fashion',
  },
  health: {
    US: 'hpc', UK: 'drugstore', CA: 'hpc',
    DE: 'drugstore', FR: 'hpc', IT: 'hpc',
    ES: 'hpc', IN: 'hpc', JP: 'hpc', AU: 'hpc',
    AE: 'health',
  },
  home: {
    US: 'home-garden', UK: 'home-garden', CA: 'kitchen',
    DE: 'kitchen', FR: 'kitchen', IT: 'kitchen',
    ES: 'kitchen', IN: 'kitchen', JP: 'kitchen', AU: 'home',
    AE: 'home',
  },
  books: {
    US: 'books', UK: 'books', CA: 'books',
    DE: 'books', FR: 'books', IT: 'books',
    ES: 'books', IN: 'books', JP: 'books', AU: 'books',
    AE: 'books',
  },
  grocery: {
    US: 'grocery', UK: 'grocery', CA: 'grocery',
    DE: 'grocery', FR: 'grocery', IT: 'grocery',
    ES: 'grocery', IN: 'grocery', JP: 'food-beverage', AU: 'pantry',
    AE: 'grocery',
  },
  office: {
    US: 'office-products', UK: 'office-products', CA: 'office',
    DE: 'office-products', FR: 'office-products', IT: 'office',
    ES: 'office', IN: 'office', JP: 'office-products', AU: 'office-products',
    AE: 'office-products',
  },
  petSupplies: {
    US: 'pet-supplies', UK: 'pet-supplies', CA: 'pet-supplies',
    DE: 'pet-supplies', FR: 'pet-supplies', IT: 'pet-supplies',
    ES: 'pet-supplies', IN: 'pet-supplies', JP: 'pet-supplies', AU: 'pets',
    AE: 'pet-supplies',
  },
  automotive: {
    US: 'automotive', UK: 'automotive', CA: 'automotive',
    DE: 'automotive', FR: 'automotive', IT: 'automotive',
    ES: 'automotive', IN: 'car-motorbike', JP: 'automotive', AU: 'automotive',
    AE: 'automotive',
  },
  baby: {
    US: 'baby-products', UK: 'baby', CA: 'baby',
    DE: 'baby', FR: 'baby', IT: 'baby',
    ES: 'baby', IN: 'baby', JP: 'baby', AU: 'baby',
    AE: 'baby-products',
  },
  tools: {
    US: 'hi', UK: 'diy', CA: 'hi',
    DE: 'diy', FR: 'diy', IT: 'diy',
    ES: 'diy', IN: 'home-improvement', JP: 'diy', AU: 'home-improvement',
    AE: 'home-improvement',
  },
  videogames: {
    US: 'videogames', UK: 'videogames', CA: 'videogames',
    DE: 'videogames', FR: 'videogames', IT: 'videogames',
    ES: 'videogames', IN: 'videogames', JP: 'videogames', AU: 'videogames',
    AE: 'videogames',
  },
};

const COUNTRY_CATEGORY_PATH_ALIASES: Record<string, Record<string, string[]>> = {
  AE: {
    sports: ['sports'],
    health: ['hpc'],
    home: ['home-garden'],
    baby: ['baby'],
    tools: ['hi'],
  },
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function randomDelay(
  minMs: number = 1500,
  maxMs: number = 4000,
  shouldStop?: () => boolean
): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs) + minMs);
  const startedAt = Date.now();

  while (Date.now() - startedAt < delay) {
    if (shouldStop?.()) {
      throw new ScrapeCancelledError();
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

export class AmazonScraper {
  // Playwright browser — lazy-loaded, only used as fallback
  private browser: any = null;
  private playwrightAvailable: boolean | null = null;

  async init(): Promise<void> {
    // No-op for HTTP mode — Playwright loaded lazily on demand
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  private throwIfStopped(shouldStop?: () => boolean): void {
    if (shouldStop?.()) {
      throw new ScrapeCancelledError();
    }
  }

  /**
   * Build the list of candidate URLs to try for a given category + country.
   * Returns multiple URLs to try in order of preference.
   */
  private buildCandidateUrls(
    categoryKey: string,
    country: string,
    pageNum: number
  ): string[] {
    const tld = COUNTRY_DOMAINS[country] || 'amazon.com';
    const config = CATEGORY_CURVES[categoryKey];
    const nodeId = config?.amazonNodeId;
    const urls: string[] = [];
    const seenPaths = new Set<string>();
    const addPathUrl = (path: string) => {
      if (!path || seenPaths.has(path)) return;
      seenPaths.add(path);

      if (pageNum === 1) {
        urls.push(`https://www.${tld}/gp/bestsellers/${path}/`);
      } else {
        urls.push(`https://www.${tld}/gp/bestsellers/${path}/ref=zg_bs_pg_${pageNum}?ie=UTF8&pg=${pageNum}`);
      }
    };

    // Strategy 1: Country-specific bestseller path (most reliable)
    const countryPaths = COUNTRY_CATEGORY_PATHS[categoryKey];
    const countryPath = countryPaths?.[country];
    if (countryPath) {
      addPathUrl(countryPath);
    }

    const countryAliases = COUNTRY_CATEGORY_PATH_ALIASES[country]?.[categoryKey] ?? [];
    for (const alias of countryAliases) {
      addPathUrl(alias);
    }

    // Strategy 2: US-derived zgbs path (works for US, sometimes for other English-speaking countries)
    if (country === 'US' && config) {
      if (pageNum === 1) {
        urls.push(config.amazonUrl);
      } else {
        urls.push(`${config.amazonUrl}ref=zg_bs_pg_${pageNum}?_encoding=UTF8&pg=${pageNum}`);
      }
    }

    // Strategy 3: Try the category key itself as a slug (works surprisingly often)
    if (categoryKey !== countryPath) {
      addPathUrl(categoryKey);
    }

    // Strategy 4: Node ID based URL (works only on the intended domain, typically US)
    if (nodeId && country === 'US') {
      if (pageNum === 1) {
        urls.push(`https://www.${tld}/gp/bestsellers/?node=${nodeId}`);
        urls.push(`https://www.${tld}/gp/bestsellers/ref=zg_bs_unv_${categoryKey}_0_${nodeId}_1?node=${nodeId}`);
      } else {
        urls.push(`https://www.${tld}/gp/bestsellers/?node=${nodeId}&pg=${pageNum}`);
      }
    }

    // Strategy 5: Extract path from US URL and try on target domain (fallback)
    if (country !== 'US' && config) {
      const zgbsMatch = config.amazonUrl.match(/\/zgbs\/([^?#]+)/);
      if (zgbsMatch) {
        const usPath = zgbsMatch[1].replace(/\/$/, '');
        if (usPath !== countryPath && usPath !== categoryKey) {
          addPathUrl(usPath);
        }
      }
    }

    return urls;
  }

  /**
   * Fetch HTML via plain HTTP with retries and proper headers.
   */
  private async fetchHtml(
    url: string,
    country: string = 'US',
    options: ScrapeRunOptions = {}
  ): Promise<string | null> {
    const maxRetries = 3;
    const lang = COUNTRY_LANG[country] || 'en-US,en;q=0.9';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.throwIfStopped(options.shouldStop);
        const controller = new AbortController();
        options.setAbortController?.(controller);
        const timeout = setTimeout(() => controller.abort(), 20000);

        const res = await fetch(url, {
          signal: controller.signal,
          redirect: 'follow',
          headers: {
            'User-Agent': randomUA(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': lang,
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'Connection': 'keep-alive',
          },
        });
        clearTimeout(timeout);
        options.setAbortController?.(null);

        if (!res.ok) {
          console.warn(`  HTTP ${res.status} fetching ${url} (attempt ${attempt}/${maxRetries})`);
          if (attempt < maxRetries) {
            await randomDelay(2000 * attempt, 4000 * attempt, options.shouldStop);
            continue;
          }
          return null;
        }

        const html = await res.text();

        // Check for CAPTCHA
        if (html.includes('/errors/validateCaptcha') || html.includes('Type the characters you see in this image')) {
          console.warn(`  CAPTCHA detected for ${url} (attempt ${attempt}/${maxRetries})`);
          if (attempt < maxRetries) {
            await randomDelay(3000 * attempt, 6000 * attempt, options.shouldStop);
            continue;
          }
          return null;
        }

        // Check for empty/redirect page
        if (html.length < 5000) {
          console.warn(`  Suspiciously short page (${html.length} bytes) for ${url}`);
          if (attempt < maxRetries) {
            await randomDelay(2000, 4000, options.shouldStop);
            continue;
          }
        }

        return html;
      } catch (err) {
        options.setAbortController?.(null);
        if (options.shouldStop?.()) {
          throw new ScrapeCancelledError();
        }
        console.warn(`  HTTP fetch failed for ${url} (attempt ${attempt}/${maxRetries}):`, (err as Error).message);
        if (attempt < maxRetries) {
          await randomDelay(2000 * attempt, 5000 * attempt, options.shouldStop);
          continue;
        }
        return null;
      }
    }
    return null;
  }

  /**
   * Fetch HTML via Playwright headless browser (fallback).
   */
  private async fetchHtmlPlaywright(
    url: string,
    country: string = 'US',
    options: ScrapeRunOptions = {}
  ): Promise<string | null> {
    // Lazy-check if Playwright is available
    if (this.playwrightAvailable === false) return null;

    try {
      this.throwIfStopped(options.shouldStop);
      if (!this.browser) {
        const pw = await import('playwright');
        this.browser = await pw.chromium.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
          ],
        });
        this.playwrightAvailable = true;
      }

      const lang = COUNTRY_LANG[country] || 'en-US,en;q=0.9';
      const context = await this.browser.newContext({
        userAgent: randomUA(),
        viewport: { width: 1366, height: 768 },
        locale: lang.split(',')[0].split('-').join('-'),
        extraHTTPHeaders: {
          'Accept-Language': lang,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        },
      });

      const page = await context.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await randomDelay(2000, 4000, options.shouldStop);
      this.throwIfStopped(options.shouldStop);

      const isCaptcha = await page.$('form[action="/errors/validateCaptcha"]');
      if (isCaptcha) {
        console.warn(`  CAPTCHA detected via Playwright for ${url}`);
        await context.close();
        return null;
      }

      const html = await page.content();
      await context.close();
      return html;
    } catch (err) {
      console.warn(`  Playwright fetch failed for ${url}:`, (err as Error).message);
      if ((err as Error).message.includes("Executable doesn't exist")) {
        this.playwrightAvailable = false;
        console.warn('  Playwright browsers not installed — run `npx playwright install chromium`');
      }
      return null;
    }
  }

  /**
   * Try to fetch HTML from multiple candidate URLs until one succeeds.
   */
  private async fetchWithFallback(
    urls: string[],
    country: string,
    options: ScrapeRunOptions = {}
  ): Promise<{ html: string; url: string } | null> {
    const isValidPage = (h: string) => {
      if (h.length < 5000) return false;
      // Check for category-not-found message (JP returns this for invalid slugs)
      if (h.includes('このカテゴリには注文可能な売れ筋ランキングがありません') ||
          h.includes('no Best Sellers rank') ||
          h.includes('Es gibt keine Bestseller-Rangliste')) {
        return false;
      }
      // Check for data-asin attributes or direct /dp/ ASIN links
      const hasDataAsin = (h.match(/data-asin=/g) || []).length >= 3;
      const hasDpLinks = (h.match(/\/dp\/[A-Z0-9]{10}/g) || []).length >= 5;
      
      return hasDataAsin || hasDpLinks;
    };

    for (const url of urls) {
      console.log(`    ↳ Trying: ${url}`);

      // Try HTTP first
      this.throwIfStopped(options.shouldStop);
      let html = await this.fetchHtml(url, country, options);
      if (html && isValidPage(html)) {
        return { html, url };
      }

      // Small delay between URL attempts
      await randomDelay(1000, 2000, options.shouldStop);
    }

    // Last resort: try Playwright on all URLs
    for (const url of urls) {
      console.log(`    🔄 Falling back to Playwright for: ${url}`);
      this.throwIfStopped(options.shouldStop);
      const html = await this.fetchHtmlPlaywright(url, country, options);
      if (html && isValidPage(html)) {
        return { html, url };
      }
      await randomDelay(1000, 2000, options.shouldStop);
    }

    return null;
  }

  /**
   * Scrape the top products from an Amazon Best Sellers category page.
   * Uses multiple URL strategies and retries for reliability.
   */
  async scrapeBestSellersCategory(
    categoryKey: string,
    country: string = 'US',
    maxProducts: number = 100,
    options: ScrapeRunOptions = {}
  ): Promise<ScrapedProduct[]> {
    const config = CATEGORY_CURVES[categoryKey];
    if (!config) throw new Error(`Unknown category: ${categoryKey}`);

    const countryUp = country.toUpperCase();
    const tld = COUNTRY_DOMAINS[countryUp] || 'amazon.com';

    console.log(`  🌐 Scraping ${categoryKey} for ${countryUp} (${tld})`);

    const products: ScrapedProduct[] = [];
    const pageSizeEstimate = 30;
    const pagesToScrape = Math.max(1, Math.ceil(maxProducts / pageSizeEstimate));

    for (let pageNum = 1; pageNum <= pagesToScrape; pageNum++) {
      this.throwIfStopped(options.shouldStop);
      // Build multiple candidate URLs for this page
      const candidateUrls = this.buildCandidateUrls(categoryKey, countryUp, pageNum);
      console.log(`  📡 Fetching ${categoryKey} page ${pageNum} (${countryUp}) — ${candidateUrls.length} candidate URLs`);

      const result = await this.fetchWithFallback(candidateUrls, countryUp, options);

      if (!result) {
        console.warn(`  ⚠ Could not fetch ${categoryKey} page ${pageNum} from any URL. Skipping.`);
        continue;
      }

      console.log(`  ✓ Got HTML from: ${result.url} (${result.html.length} bytes)`);

      const pageProducts = this.parseProductsFromHtml(result.html, categoryKey, pageNum, countryUp, tld);
      console.log(`  📦 Parsed ${pageProducts.length} products from ${categoryKey} page ${pageNum}`);
      products.push(...pageProducts);

      if (products.length >= maxProducts) {
        console.log(`  Reached target of ${maxProducts} products for ${categoryKey} (${countryUp})`);
        break;
      }

      if (pageNum < pagesToScrape) {
        await randomDelay(2000, 5000, options.shouldStop);
      }
    }

    if (products.length === 0) {
      console.warn(`  ⚠ No products extracted for ${categoryKey} (${countryUp}).`);
      console.warn(`    Possible causes: Amazon CAPTCHA, changed page structure, or wrong category path.`);
      console.warn(`    Tried URLs: ${this.buildCandidateUrls(categoryKey, countryUp, 1).join(', ')}`);
    } else {
      console.log(`  ✅ Total: ${products.length} products for ${categoryKey} (${countryUp})`);
    }

    return products.slice(0, maxProducts);
  }

  private parseProductsFromHtml(
    html: string,
    categoryKey: string,
    pageNum: number,
    country: string,
    tld: string
  ): ScrapedProduct[] {
    const $ = cheerio.load(html);
    const products: ScrapedProduct[] = [];

    // Try multiple container selectors for Amazon Best Sellers pages.
    // Amazon changes their DOM frequently so we try many options.
    const productSelectors = [
      '[id^="gridItemRoot"]',
      '.zg-grid-general-faceout',
      '.zg-item-immersion',
      '.p13n-sc-uncoverable-faceout',
      '#zg-ordered-list li',
      '.a-carousel-card',
      '[data-component-type="s-search-result"]',
    ];

    let $items: ReturnType<typeof $> | null = null;
    for (const selector of productSelectors) {
      const selected = $(selector);
      if (selected.length > 0) {
        console.log(`    ✓ Matched selector: "${selector}" (${selected.length} items)`);
        $items = selected;
        break;
      }
    }

    if (!$items || $items.length === 0) {
      // Last resort: try to find any element with a data-asin attribute
      const asinElements = $('[data-asin]').filter((_, el) => {
        const asin = $(el).attr('data-asin');
        return !!asin && asin.length === 10;
      });
      if (asinElements.length > 0) {
        console.log(`    ✓ Fallback matched data-asin elements (${asinElements.length} items)`);
        $items = asinElements;
      } else {
        // Try extracting from /dp/ links as absolute last resort
        const dpProducts = this.extractFromDpLinks($, categoryKey, pageNum, country, tld);
        if (dpProducts.length > 0) {
          console.log(`    ✓ Extracted ${dpProducts.length} products from /dp/ links`);
          return dpProducts;
        }
        console.warn(`    ✗ No products found with any selector on page ${pageNum}`);
        return products;
      }
    }

    $items.each((index, el) => {
      try {
        const $el = $(el);
        const rank = (pageNum - 1) * 50 + index + 1;

        // Extract ASIN
        const asin = $el.attr('data-asin')
          || $el.find('[data-asin]').first().attr('data-asin')
          || extractAsinFromUrl($el.find('a[href*="/dp/"]').first().attr('href') || '')
          || extractAsinFromUrl($el.find('a').first().attr('href') || '');

        if (!asin || asin.length !== 10) return;

        // Extract title — try many selectors
        const title =
          $el.find('div[class*="p13n-sc-truncate"], span[class*="p13n-sc-truncate"]').first().text().trim() ||
          $el.find('div[class*="line-clamp"]').first().text().trim() ||
          $el.find('a[title]').first().attr('title')?.trim() ||
          $el.find('.a-link-normal span').first().text().trim() ||
          $el.find('span.zg-text-center-align').text().trim() ||
          $el.find('a.a-link-normal').first().text().trim() ||
          '';

        if (!title || title.length < 3) return;

        // Extract price
        const priceText = $el.find('.a-price .a-offscreen, .p13n-sc-price, ._cDEzb_p13n-sc-price_3mJ9Z, .a-color-price').first().text();
        let priceUsd: number | undefined;
        if (priceText) {
          const match = priceText.match(/[\d,.]+/);
          if (match) {
            // Handle European number format (1.234,56 → 1234.56)
            let priceStr = match[0];
            if (priceStr.includes(',') && priceStr.indexOf(',') > priceStr.lastIndexOf('.')) {
              // European format: 1.234,56
              priceStr = priceStr.replace(/\./g, '').replace(',', '.');
            } else {
              // US format: 1,234.56
              priceStr = priceStr.replace(/,/g, '');
            }
            priceUsd = parseFloat(priceStr);
            if (isNaN(priceUsd)) priceUsd = undefined;
          }
        }

        // Extract rating
        const ratingText =
          $el.find('.a-icon-alt').first().text() ||
          $el.find('[title*="out of 5"]').first().attr('title') ||
          $el.find('[title*="von 5"]').first().attr('title') ||
          $el.find('[title*="su 5"]').first().attr('title') ||
          $el.find('[title*="sur 5"]').first().attr('title') ||
          '';
        const ratingMatch = ratingText.match(/([\d.,]+)\s*(out of|von|su|sur|de)/);
        const rating = ratingMatch ? parseFloat(ratingMatch[1].replace(',', '.')) : undefined;

        // Extract review count
        const reviewEl = $el.find('span.a-size-small, .a-size-small .a-link-normal').first().text();
        const reviewMatch = reviewEl.replace(/[.,]/g, '').match(/(\d+)/);
        const reviewCount = reviewMatch ? parseInt(reviewMatch[1]) : undefined;

        // Extract image URL — try multiple sources
        const imageUrl =
          $el.find('img').first().attr('data-a-hires') ||
          $el.find('img[src*="images-amazon"], img[src*="m.media-amazon"]').first().attr('src') ||
          $el.find('img.a-dynamic-image, img.s-image').first().attr('src') ||
          $el.find('img').first().attr('src') ||
          undefined;

        // Filter out tiny placeholder images
        const validImage = imageUrl && !imageUrl.includes('sprite') && !imageUrl.includes('grey-pixel')
          ? imageUrl : undefined;

        // Extract brand
        const brand = $el.find('span.a-size-small.a-color-base, span[class*="a-size-small"]').first().text().trim() || undefined;

        products.push({
          asin,
          country,
          title: title.slice(0, 400), // Truncate very long titles
          brand: brand && brand.length > 1 && brand.length < 100 ? brand : undefined,
          imageUrl: validImage,
          productUrl: `https://www.${tld}/dp/${asin}`,
          bsrCategory: rank,
          category: categoryKey,
          priceUsd,
          reviewCount,
          rating,
        });
      } catch {
        // Skip malformed product elements
      }
    });

    return products;
  }

  /**
   * Last-resort extraction: find all /dp/ links and build products from them.
   */
  private extractFromDpLinks(
    $: cheerio.CheerioAPI,
    categoryKey: string,
    pageNum: number,
    country: string,
    tld: string
  ): ScrapedProduct[] {
    const products: ScrapedProduct[] = [];
    const seenAsins = new Set<string>();
    const dpLinks = $('a[href*="/dp/"]');

    if (dpLinks.length === 0) return products;

    dpLinks.each((_, el) => {
      const $link = $(el);
      const href = $link.attr('href') || '';

      const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/);
      if (!asinMatch) return;
      const asin = asinMatch[1];

      if (seenAsins.has(asin)) return;

      let name = $link.text().trim();
      if (!name || name.length < 3) {
        name = $link.attr('title')?.trim() || '';
      }

      // Skip navigation links
      if (!name || name.length < 5) return;
      if (name.toLowerCase().includes('see top 100')) return;
      if (name.toLowerCase().includes('hot new releases')) return;

      seenAsins.add(asin);

      products.push({
        asin,
        country,
        title: name.slice(0, 400),
        productUrl: `https://www.${tld}/dp/${asin}`,
        bsrCategory: (pageNum - 1) * 50 + products.length + 1,
        category: categoryKey,
      });
    });

    return products;
  }
}

function extractAsinFromUrl(url: string): string {
  const match = url.match(/\/dp\/([A-Z0-9]{10})/);
  return match ? match[1] : '';
}
