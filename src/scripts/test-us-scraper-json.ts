import { AmazonScraper } from '../scraper/amazon-scraper.js';
import { CATEGORY_KEYS, CATEGORY_CURVES } from '../estimation/category-curves.js';
import fs from 'fs';

async function testAll() {
  const scraper = new AmazonScraper();
  await scraper.init();
  
  const results = {};
  
  for (const cat of CATEGORY_KEYS) {
    try {
      const products = await scraper.scrapeBestSellersCategory(cat, 'JP', 60);
      if (products.length > 0) {
        results[cat] = 'SUCCESS (' + products.length + ')';
      } else {
        results[cat] = 'FAILED';
      }
    } catch (err) {
      results[cat] = 'ERROR: ' + err.message;
    }
  }
  
  await scraper.close();
  
  fs.writeFileSync('clean-results.json', JSON.stringify(results, null, 2), 'utf-8');
  process.exit(0);
}

testAll().catch(console.error);
