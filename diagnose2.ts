import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const prisma = new PrismaClient();

async function main() {
  const out: string[] = [];

  const productsByCountry = await prisma.$queryRawUnsafe<any[]>(
    `SELECT country, COUNT(*)::int as cnt FROM products GROUP BY country ORDER BY cnt DESC`
  );
  out.push('=== Products by Country ===');
  for (const r of productsByCountry) out.push(`  ${r.country}: ${r.cnt}`);

  const bsrByCountry = await prisma.$queryRawUnsafe<any[]>(
    `SELECT country, COUNT(*)::int as cnt FROM bsr_snapshots GROUP BY country ORDER BY cnt DESC`
  );
  out.push('\n=== BSR Snapshots by Country ===');
  for (const r of bsrByCountry) out.push(`  ${r.country}: ${r.cnt}`);

  const nonUsJobs = await prisma.$queryRawUnsafe<any[]>(
    `SELECT country, category_url, status, products_found, error_message 
     FROM scrape_jobs 
     WHERE country != 'US' 
     ORDER BY created_at DESC 
     LIMIT 30`
  );
  out.push('\n=== Recent Non-US Scrape Jobs ===');
  for (const j of nonUsJobs) {
    out.push(`  ${j.country} | ${j.category_url} | ${j.status} | ${j.products_found} prods | err: ${j.error_message || 'none'}`);
  }

  const stuckJobs = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, country, category_url, status, started_at 
     FROM scrape_jobs 
     WHERE status = 'running' 
     ORDER BY started_at ASC`
  );
  out.push('\n=== Stuck Running Jobs ===');
  for (const j of stuckJobs) out.push(`  id=${j.id} ${j.country} | ${j.category_url}`);
  if (stuckJobs.length === 0) out.push('  None');

  const jpProducts = await prisma.$queryRawUnsafe<any[]>(
    `SELECT primary_category, COUNT(*)::int as cnt FROM products WHERE country = 'JP' GROUP BY primary_category ORDER BY cnt DESC`
  );
  out.push('\n=== JP Products by Category ===');
  for (const r of jpProducts) out.push(`  ${r.primary_category}: ${r.cnt}`);
  if (jpProducts.length === 0) out.push('  No JP products in database');

  const report = out.join('\n');
  fs.writeFileSync('diagnose-report.txt', report);
  console.log(report);

  await prisma.$disconnect();
}

main().catch(console.error);
