import 'dotenv/config';
import { triggerAllScrapes } from '../queue/scrape-queue.js';

/**
 * One-off script to trigger scraping all categories manually.
 * Run: pnpm scrape:all
 */
async function main() {
  console.log('🔄 Triggering scrape for all categories...');
  const jobIds = await triggerAllScrapes();
  console.log(`✅ Queued ${jobIds.length} scrape jobs`);
  console.log('Job IDs:', jobIds);
  process.exit(0);
}

main().catch(console.error);
