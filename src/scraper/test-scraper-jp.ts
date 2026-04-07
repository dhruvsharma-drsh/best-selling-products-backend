import { AmazonScraper } from './amazon-scraper.js';

async function main() {
  const scraper = new AmazonScraper();
  
  // Test JP health
  console.log('--- Testing JP Health ---');
  const jpHealth = await scraper.scrapeBestSellersCategory('health', 'JP', 10);
  console.log(`Found ${jpHealth.length} products`);
  if (jpHealth.length > 0) console.log(jpHealth[0]);

  // Test DE office
  console.log('\n--- Testing DE Office ---');
  const deOffice = await scraper.scrapeBestSellersCategory('office', 'DE', 10);
  console.log(`Found ${deOffice.length} products`);
  
  // Test CA home
  console.log('\n--- Testing CA Home ---');
  const caHome = await scraper.scrapeBestSellersCategory('home', 'CA', 10);
  console.log(`Found ${caHome.length} products`);

  await scraper.close();
}

main().catch(console.error);
