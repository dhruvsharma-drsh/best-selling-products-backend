import { AmazonScraper } from '../scraper/amazon-scraper.js';
import { CATEGORY_KEYS, CATEGORY_CURVES } from '../estimation/category-curves.js';

async function testAll() {
  const scraper = new AmazonScraper();
  await scraper.init();
  
  const results = {};
  
  for (const cat of CATEGORY_KEYS) {
    try {
      console.log(`\nTesting ${CATEGORY_CURVES[cat].displayName} (${cat})...`);
      const products = await scraper.scrapeBestSellersCategory(cat, 'US', 10);
      if (products.length > 0) {
        console.log(`✅ SUCCESS: Got ${products.length} products`);
        results[cat] = 'SUCCESS';
      } else {
        console.log(`❌ FAILED: Got 0 products`);
        results[cat] = 'FAILED (0 products)';
      }
    } catch (err) {
      console.log(`❌ ERROR:`, err.message);
      results[cat] = `ERROR: ${err.message}`;
    }
  }
  
  await scraper.close();
  
  console.log('\n\n--- SUMMARY ---');
  for (const [cat, res] of Object.entries(results)) {
    console.log(`${CATEGORY_CURVES[cat].displayName}: ${res}`);
  }
  process.exit(0);
}

testAll().catch(console.error);
