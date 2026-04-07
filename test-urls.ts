import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Test which Amazon bestseller URLs actually return products
const DOMAINS: Record<string, string> = {
  US: 'amazon.com',
  JP: 'amazon.co.jp',
  DE: 'amazon.de',
  UK: 'amazon.co.uk',
  FR: 'amazon.fr',
  CA: 'amazon.ca',
  IN: 'amazon.in',
  IT: 'amazon.it',
  ES: 'amazon.es',
};

// Test multiple slug variations for the "health" category
const HEALTH_SLUGS = ['hpc', 'health-personal-care', 'health', 'drugstore', 'beauty', 'health-and-beauty'];
// Test for electronics 
const ELEC_SLUGS = ['electronics', 'ce-de'];
// Test for office
const OFFICE_SLUGS = ['office-products', 'office', 'stationery-office-supplies'];
// Test for home
const HOME_SLUGS = ['home-garden', 'home', 'kitchen', 'home-improvement', 'garden'];
// Test for grocery
const GROCERY_SLUGS = ['grocery', 'food-beverage', 'pantry', 'grocery-gourmet-food'];

const CATEGORIES_TO_TEST: Record<string, string[]> = {
  health: HEALTH_SLUGS,
  electronics: ELEC_SLUGS,
  office: OFFICE_SLUGS,
  home: HOME_SLUGS,
  grocery: GROCERY_SLUGS,
};

async function testUrl(url: string): Promise<{ok: boolean; productCount: number; size: number}> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8,de;q=0.7,fr;q=0.6',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, productCount: 0, size: 0 };
    const html = await res.text();
    const asinMatches = html.match(/data-asin="[A-Z0-9]{10}"/g);
    const productCount = asinMatches ? asinMatches.length : 0;
    return { ok: true, productCount, size: html.length };
  } catch {
    return { ok: false, productCount: 0, size: 0 };
  }
}

async function main() {
  const results: string[] = [];
  const working: Record<string, Record<string, string>> = {};
  
  // Test problematic countries: JP, DE, CA (the ones with 0-product categories) 
  const testCountries = ['JP', 'DE', 'CA', 'UK', 'IN', 'FR', 'IT', 'ES'];
  
  for (const [catKey, slugs] of Object.entries(CATEGORIES_TO_TEST)) {
    results.push(`\n=== ${catKey.toUpperCase()} ===`);
    working[catKey] = {};
    
    for (const country of testCountries) {
      const domain = DOMAINS[country];
      let found = false;
      
      for (const slug of slugs) {
        const url = `https://www.${domain}/gp/bestsellers/${slug}/`;
        const result = await testUrl(url);
        
        if (result.productCount >= 3) {
          results.push(`  ✅ ${country} (${domain}): /${slug}/ → ${result.productCount} products (${result.size} bytes)`);
          working[catKey][country] = slug;
          found = true;
          break;
        } else if (result.ok && result.size > 5000) {
          results.push(`  ⚠️  ${country} (${domain}): /${slug}/ → ${result.productCount} products (${result.size} bytes) - page loaded but no/few products`);
        }
      }
      
      if (!found) {
        results.push(`  ❌ ${country} (${domain}): NO WORKING SLUG found for ${catKey}`);
      }
      
      // Small delay between requests
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  results.push('\n\n=== RECOMMENDED CATEGORY_PATHS UPDATE ===');
  for (const [catKey, countryMap] of Object.entries(working)) {
    results.push(`  ${catKey}: ${JSON.stringify(countryMap)}`);
  }
  
  const report = results.join('\n');
  const fs = await import('fs');
  fs.writeFileSync('url-test-report.txt', report);
  console.log(report);
}

main().catch(console.error);
