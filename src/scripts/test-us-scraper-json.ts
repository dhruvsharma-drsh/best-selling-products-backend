import fs from 'fs';
import { AmazonScraper } from '../scraper/amazon-scraper.js';
import { CATEGORY_KEYS, CATEGORY_CURVES } from '../estimation/category-curves.js';

type CategoryKey = keyof typeof CATEGORY_CURVES;

async function testAll() {
  const scraper = new AmazonScraper();
  await scraper.init();

  const results: Partial<Record<CategoryKey, string>> = {};

  for (const cat of CATEGORY_KEYS) {
    try {
      const products = await scraper.scrapeBestSellersCategory(cat, 'JP', 60);
      results[cat] = products.length > 0 ? `SUCCESS (${products.length})` : 'FAILED';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results[cat] = `ERROR: ${message}`;
    }
  }

  await scraper.close();

  fs.writeFileSync('clean-results.json', JSON.stringify(results, null, 2), 'utf-8');
}

testAll().catch(console.error);
