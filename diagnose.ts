import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const prisma = new PrismaClient();

async function main() {
  // 1. Products by country
  const productsByCountry = await prisma.$queryRawUnsafe<any[]>(
    `SELECT country, COUNT(*)::int as cnt FROM products GROUP BY country ORDER BY cnt DESC`
  );
  console.log('\n=== Products by Country ===');
  console.log(JSON.stringify(productsByCountry, null, 2));

  // 2. BSR snapshots by country
  const bsrByCountry = await prisma.$queryRawUnsafe<any[]>(
    `SELECT country, COUNT(*)::int as cnt FROM bsr_snapshots GROUP BY country ORDER BY cnt DESC`
  );
  console.log('\n=== BSR Snapshots by Country ===');
  console.log(JSON.stringify(bsrByCountry, null, 2));

  // 3. Recent scrape jobs for non-US
  const nonUsJobs = await prisma.$queryRawUnsafe<any[]>(
    `SELECT country, category_url, status, products_found, error_message, created_at 
     FROM scrape_jobs 
     WHERE country != 'US' 
     ORDER BY created_at DESC 
     LIMIT 20`
  );
  console.log('\n=== Recent Non-US Scrape Jobs ===');
  for (const job of nonUsJobs) {
    console.log(`  ${job.country} | ${job.category_url} | ${job.status} | ${job.products_found} products | ${job.error_message || 'no error'}`);
  }

  // 4. Failed jobs summary
  const failedJobs = await prisma.$queryRawUnsafe<any[]>(
    `SELECT country, category_url, error_message, COUNT(*)::int as cnt 
     FROM scrape_jobs 
     WHERE status = 'failed' 
     GROUP BY country, category_url, error_message 
     ORDER BY cnt DESC 
     LIMIT 20`
  );
  console.log('\n=== Failed Jobs Summary ===');
  for (const job of failedJobs) {
    console.log(`  ${job.country} | ${job.category_url} | ${job.cnt}x | ${job.error_message}`);
  }

  // 5. Stuck "running" jobs
  const stuckJobs = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, country, category_url, started_at 
     FROM scrape_jobs 
     WHERE status = 'running' 
     ORDER BY started_at ASC`
  );
  console.log('\n=== Stuck Running Jobs ===');
  console.log(JSON.stringify(stuckJobs, null, 2));

  // 6. JP specifically
  const jpProducts = await prisma.$queryRawUnsafe<any[]>(
    `SELECT primary_category, COUNT(*)::int as cnt FROM products WHERE country = 'JP' GROUP BY primary_category ORDER BY cnt DESC`
  );
  console.log('\n=== JP Products by Category ===');
  console.log(JSON.stringify(jpProducts, null, 2));

  await prisma.$disconnect();
}

main().catch(console.error);
