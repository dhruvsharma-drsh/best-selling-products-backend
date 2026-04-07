import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Check what the actual DOM looks like on pages that return 0 data-asin matches
// but have 300KB+ content (like DE office, UK office, FR office)
async function fetchAndAnalyze(url: string, label: string) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,de;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text();
    const $ = cheerio.load(html);

    console.log(`\n=== ${label} (${url}) ===`);
    console.log(`  Size: ${html.length} bytes`);
    
    // Check for data-asin
    const dataAsins = $('[data-asin]');
    console.log(`  data-asin elements: ${dataAsins.length}`);
    
    // What kind of best sellers page is this?
    const gridItems = $('[id^="gridItemRoot"]');
    console.log(`  gridItemRoot elements: ${gridItems.length}`);
    
    const zgItems = $('.zg-grid-general-faceout');
    console.log(`  zg-grid-general-faceout: ${zgItems.length}`);
    
    const p13n = $('.p13n-sc-uncoverable-faceout');
    console.log(`  p13n-sc-uncoverable-faceout: ${p13n.length}`);

    const zgList = $('#zg-ordered-list li');
    console.log(`  #zg-ordered-list li: ${zgList.length}`);
    
    // Check for /dp/ links
    const dpLinks = $('a[href*="/dp/"]');
    console.log(`  /dp/ links: ${dpLinks.length}`);
    
    // Check for any bestseller content indicators
    const hasBestSellers = html.includes('bestseller') || html.includes('Best Seller') || html.includes('Bestseller') || html.includes('Meistverkauft');
    console.log(`  Has bestseller indicator: ${hasBestSellers}`);
    
    // Check if it's a category listing page or a redirect
    const title = $('title').text();
    console.log(`  Page title: "${title.trim().slice(0, 100)}"`);
    
    // Check for "no bestsellers available" type messages
    const noRanking = html.includes('keine Bestseller') || html.includes('no Best Sellers') || html.includes('ランキングがありません');
    console.log(`  Has "no bestsellers" message: ${noRanking}`);
    
    // Look at div structure
    const carousel = $('.a-carousel-card');
    console.log(`  Carousel cards: ${carousel.length}`);
    
    // Check for a different product container pattern
    const divWithRole = $('div[role="listitem"]');
    console.log(`  div[role=listitem]: ${divWithRole.length}`);
    
    // Check for items with image links to /dp/
    const productLinks = $('a[href*="/dp/"]').map((_, el) => $(el).attr('href')).get().slice(0, 5);
    console.log(`  Sample dp links: ${productLinks.join(', ')}`);
    
  } catch (err) {
    console.log(`  ERROR: ${(err as Error).message}`);
  }
}

async function main() {
  // Test the problematic pages - pages that load but return 0 products
  await fetchAndAnalyze('https://www.amazon.de/gp/bestsellers/hpc/', 'DE health (hpc - broken)');
  await fetchAndAnalyze('https://www.amazon.de/gp/bestsellers/drugstore/', 'DE health (drugstore - works)');
  await fetchAndAnalyze('https://www.amazon.de/gp/bestsellers/office-products/', 'DE office (office-products - broken)');
  await fetchAndAnalyze('https://www.amazon.co.uk/gp/bestsellers/office-products/', 'UK office (office-products - broken)');
}

main().catch(console.error);
