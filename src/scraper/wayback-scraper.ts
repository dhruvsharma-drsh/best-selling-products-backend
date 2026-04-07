import * as cheerio from 'cheerio';

export interface ArchiveProduct {
  asin: string;
  productName: string;
  rank: number;
  category: string;
  rating?: number;
  reviewCount?: number;
  imageUrl?: string;
}

export interface WaybackSnapshot {
  timestamp: string;
  originalUrl: string;
  date: string;        // YYYY-MM-DD
  archiveUrl: string;  // full web.archive.org URL
}

const WAYBACK_CDX_API = 'https://web.archive.org/cdx/search/cdx';
const WAYBACK_BASE = 'https://web.archive.org/web';

// Supported category paths for amazon.in bestsellers
export const ARCHIVE_CATEGORIES: Record<string, string> = {
  electronics: 'electronics',
  books: 'books',
  kitchen: 'kitchen',
  clothing: 'clothing-and-accessories',
  beauty: 'beauty',
  toys: 'toys-and-games',
  sports: 'sports-fitness-and-outdoors',
  software: 'software',
  'home-improvement': 'home-improvement',
  automotive: 'automotive',
};

/**
 * Discover available Wayback Machine snapshots for a category.
 */
export async function discoverSnapshots(
  category: string = 'electronics',
  startYear?: number,
  endYear?: number,
  limit: number = 500
): Promise<WaybackSnapshot[]> {
  const categoryPath = ARCHIVE_CATEGORIES[category] || category;
  const targetUrl = `amazon.in/gp/bestsellers/${categoryPath}`;

  const params = new URLSearchParams({
    url: targetUrl,
    output: 'json',
    fl: 'timestamp,original,statuscode',
    'filter': 'statuscode:200',
    limit: String(limit),
    collapse: 'timestamp:8', // Collapse to 1 per day (8-digit = YYYYMMDD)
  });

  if (startYear) params.set('from', `${startYear}0101`);
  if (endYear) params.set('to', `${endYear}1231`);

  const url = `${WAYBACK_CDX_API}?${params}`;
  console.log(`🔍 Querying Wayback CDX: ${url}`);

  const res = await fetch(url, {
    headers: { 'User-Agent': 'AmazonIntelligencePlatform/1.0 (historical-research)' },
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`CDX API returned ${res.status}: ${res.statusText}`);
  }

  const text = await res.text();
  if (!text.trim()) return [];

  const rows: string[][] = JSON.parse(text);
  // First row is headers: ["timestamp", "original", "statuscode"]
  const dataRows = rows.slice(1);

  return dataRows.map(([timestamp, original]) => {
    const year = timestamp.slice(0, 4);
    const month = timestamp.slice(4, 6);
    const day = timestamp.slice(6, 8);

    return {
      timestamp,
      originalUrl: original,
      date: `${year}-${month}-${day}`,
      archiveUrl: `${WAYBACK_BASE}/${timestamp}/${original}`,
    };
  });
}

/**
 * Fetch and parse products from a single Wayback Machine archived page.
 */
export async function scrapeArchivePage(
  archiveUrl: string,
  category: string
): Promise<ArchiveProduct[]> {
  console.log(`📥 Fetching archive: ${archiveUrl}`);

  const res = await fetch(archiveUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`Archive fetch returned ${res.status} for ${archiveUrl}`);
  }

  const html = await res.text();
  return parseArchiveHtml(html, category);
}

/**
 * Parse archived Amazon bestsellers HTML to extract products.
 * Handles multiple era-specific page structures (2013-2020+).
 */
function parseArchiveHtml(html: string, category: string): ArchiveProduct[] {
  const $ = cheerio.load(html);
  const products: ArchiveProduct[] = [];
  const seenAsins = new Set<string>();

  // ── Strategy 1: Modern layout with zg-item elements ──
  const modernSelectors = [
    '[id^="gridItemRoot"]',
    '.zg-grid-general-faceout',
    '.zg-item-immersion',
    '.p13n-sc-uncoverable-faceout',
    '#zg-ordered-list li',
  ];

  for (const selector of modernSelectors) {
    const $items = $(selector);
    if ($items.length > 0) {
      console.log(`  ✓ Archive matched modern selector: "${selector}" (${$items.length} items)`);
      $items.each((index, el) => {
        const product = extractModernProduct($, el, index, category);
        if (product && !seenAsins.has(product.asin)) {
          seenAsins.add(product.asin);
          products.push(product);
        }
      });
      if (products.length > 0) return products;
    }
  }

  // ── Strategy 2: Legacy layout — product links with /dp/ in href ──
  // Archived 2013-2016 pages often have a much simpler flat list structure.
  const dpLinks = $('a[href*="/dp/"]');
  if (dpLinks.length > 0) {
    console.log(`  ✓ Archive fallback: found ${dpLinks.length} /dp/ links`);

    // Deduplicate — multiple links may point to same ASIN
    const asinNameMap = new Map<string, { name: string; rating?: number; reviewCount?: number }>();

    dpLinks.each((_, el) => {
      const $link = $(el);
      const href = $link.attr('href') || '';

      // Extract ASIN from href
      const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/);
      if (!asinMatch) return;
      const asin = asinMatch[1];

      // Skip if already found with a decent name
      if (asinNameMap.has(asin)) return;

      // Extract product name from link text
      let name = $link.text().trim();
      // Also check for title attribute
      if (!name || name.length < 3) {
        name = $link.attr('title')?.trim() || '';
      }

      // Skip navigation/footer/other non-product links
      if (!name || name.length < 3) return;
      if (name.toLowerCase().includes('see top 100')) return;
      if (name.toLowerCase().includes('hot new releases')) return;
      if (name.toLowerCase().includes('movers and shakers')) return;

      // Try to extract rating from nearby context
      let rating: number | undefined;
      let reviewCount: number | undefined;

      // Look at the parent and siblings for rating info
      const $parent = $link.parent();
      const parentText = $parent.text();
      const ratingMatch = parentText.match(/([\d.]+)\s*out\s*of\s*5/);
      if (ratingMatch) rating = parseFloat(ratingMatch[1]);

      // Look for review count in nearby text
      const $nextElements = $link.parent().nextAll().slice(0, 3);
      $nextElements.each((_, sib) => {
        const sibText = $(sib).text().replace(/,/g, '');
        const countMatch = sibText.match(/^(\d+)$/);
        if (countMatch && !reviewCount) {
          reviewCount = parseInt(countMatch[1]);
        }
      });

      asinNameMap.set(asin, { name, rating, reviewCount });
    });

    let rank = 1;
    for (const [asin, data] of asinNameMap) {
      // Skip very short or obviously non-product names
      if (data.name.length < 5) continue;

      products.push({
        asin,
        productName: data.name.slice(0, 400),
        rank: rank++,
        category,
        rating: data.rating,
        reviewCount: data.reviewCount,
      });
    }
  }

  // ── Strategy 3: Look for any element with data-asin ──
  if (products.length === 0) {
    const asinElements = $('[data-asin]').filter((_, el) => {
      const asin = $(el).attr('data-asin');
      return !!asin && asin.length === 10;
    });

    if (asinElements.length > 0) {
      console.log(`  ✓ Archive data-asin fallback: ${asinElements.length} elements`);
      asinElements.each((index, el) => {
        const product = extractModernProduct($, el, index, category);
        if (product && !seenAsins.has(product.asin)) {
          seenAsins.add(product.asin);
          products.push(product);
        }
      });
    }
  }

  console.log(`  📦 Extracted ${products.length} products from archive page`);
  return products;
}

/**
 * Extract product data from a modern-style Amazon bestseller DOM element.
 */
function extractModernProduct(
  $: cheerio.CheerioAPI,
  el: any,
  index: number,
  category: string
): ArchiveProduct | null {
  const $el = $(el);

  // ASIN
  const asin =
    $el.attr('data-asin') ||
    $el.find('[data-asin]').first().attr('data-asin') ||
    extractAsinFromHref($el.find('a[href*="/dp/"]').first().attr('href') || '');

  if (!asin || asin.length !== 10) return null;

  // Title
  const productName =
    $el.find('div[class*="p13n-sc-truncate"], span[class*="p13n-sc-truncate"]').first().text().trim() ||
    $el.find('div[class*="line-clamp"]').first().text().trim() ||
    $el.find('a[title]').first().attr('title')?.trim() ||
    $el.find('.a-link-normal span').first().text().trim() ||
    $el.find('a.a-link-normal').first().text().trim() ||
    '';

  if (!productName || productName.length < 3) return null;

  // Rating
  const ratingText = $el.find('.a-icon-alt').first().text() || $el.find('[title*="out of 5"]').first().attr('title') || '';
  const ratingMatch = ratingText.match(/([\d.]+)\s*out of/);
  const rating = ratingMatch ? parseFloat(ratingMatch[1]) : undefined;

  // Reviews
  const reviewText = $el.find('span.a-size-small').first().text().replace(/,/g, '');
  const reviewMatch = reviewText.match(/(\d+)/);
  const reviewCount = reviewMatch ? parseInt(reviewMatch[1]) : undefined;

  // Image
  const imageUrl =
    $el.find('img').first().attr('data-a-hires') ||
    $el.find('img[src*="images-amazon"], img[src*="m.media-amazon"]').first().attr('src') ||
    $el.find('img').first().attr('src') ||
    undefined;

  const validImage = imageUrl && !imageUrl.includes('sprite') && !imageUrl.includes('grey-pixel')
    ? imageUrl : undefined;

  return {
    asin,
    productName: productName.slice(0, 400),
    rank: index + 1,
    category,
    rating,
    reviewCount,
    imageUrl: validImage,
  };
}

function extractAsinFromHref(url: string): string {
  const match = url.match(/\/dp\/([A-Z0-9]{10})/);
  return match ? match[1] : '';
}

/**
 * Import historical data for a category from the Wayback Machine.
 * Discovers snapshots, fetches each one, and returns all products with dates.
 */
export async function importHistoricalData(
  category: string = 'electronics',
  limit: number = 50,
  startYear?: number,
  endYear?: number
): Promise<{ snapshot: WaybackSnapshot; products: ArchiveProduct[] }[]> {
  const snapshots = await discoverSnapshots(category, startYear, endYear, limit);
  console.log(`🗓️ Found ${snapshots.length} snapshots for ${category}`);

  const results: { snapshot: WaybackSnapshot; products: ArchiveProduct[] }[] = [];

  for (const snapshot of snapshots) {
    try {
      const products = await scrapeArchivePage(snapshot.archiveUrl, category);
      results.push({ snapshot, products });
      console.log(`  ✅ ${snapshot.date}: ${products.length} products`);

      // Rate-limit: be respectful to the Wayback Machine
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.warn(`  ⚠ Failed to scrape ${snapshot.date}:`, (err as Error).message);
    }
  }

  return results;
}
