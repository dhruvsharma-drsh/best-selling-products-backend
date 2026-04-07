import { AmazonScraper } from '../scraper/amazon-scraper.js';
import { CATEGORY_KEYS, CATEGORY_CURVES } from '../estimation/category-curves.js';

type CategoryKey = keyof typeof CATEGORY_CURVES;

async function testAll() {
  const scraper = new AmazonScraper();
  await scraper.init();

  const results: Partial<Record<CategoryKey, string>> = {};

  for (const cat of CATEGORY_KEYS) {
    try {
      console.log(`\nTesting ${CATEGORY_CURVES[cat].displayName} (${cat})...`);
      const products = await scraper.scrapeBestSellersCategory(cat, 'US', 10);

      if (products.length > 0) {
        console.log(`SUCCESS: Got ${products.length} products`);
        results[cat] = 'SUCCESS';
      } else {
        console.log('FAILED: Got 0 products');
        results[cat] = 'FAILED (0 products)';
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log('ERROR:', message);
      results[cat] = `ERROR: ${message}`;
    }
  }

  await scraper.close();

  console.log('\n\n--- SUMMARY ---');
  for (const [cat, result] of Object.entries(results) as [CategoryKey, string][]) {
    console.log(`${CATEGORY_CURVES[cat].displayName}: ${result}`);
  }
}

testAll().catch(console.error);
