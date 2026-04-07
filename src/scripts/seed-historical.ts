import '../config/env.js';
import { PrismaClient } from '@prisma/client';
import { CATEGORY_CURVES } from '../estimation/category-curves.js';
import { estimateMonthlySales } from '../estimation/sales-estimator.js';

/**
 * HISTORICAL DATA SEEDER
 *
 * Generates 30-90 days of realistic, simulated BSR snapshot data.
 * Creates products and populates bsr_snapshots with natural-looking
 * rank fluctuations, daily seasonality, and gradual drift.
 *
 * Usage:  pnpm seed:history
 *    or:  tsx src/scripts/seed-historical.ts
 *
 * Options (via env):
 *   SEED_DAYS=60          — Number of historical days (default: 60)
 *   SEED_INTERVAL_HOURS=2 — Hours between snapshots (default: 2, lower = more data)
 *   SEED_PRODUCTS=50      — Products per category (default: 50)
 */

// ─── Configuration ──────────────────────────────────────────────────
const SEED_DAYS = parseInt(process.env.SEED_DAYS || '30');
const SNAPSHOT_INTERVAL_HOURS = parseInt(process.env.SEED_INTERVAL_HOURS || '4');
const PRODUCTS_PER_CATEGORY = parseInt(process.env.SEED_PRODUCTS || '20');
const BATCH_SIZE = 200; // SQL inserts per batch (smaller for cloud DB)

// ─── Realistic Product Names by Category ────────────────────────────
const PRODUCT_TEMPLATES: Record<string, { brands: string[]; adjectives: string[]; nouns: string[] }> = {
  electronics: {
    brands: ['TechPro', 'NovaTech', 'ZenithAudio', 'PulseGear', 'OmniCharge', 'VoltEdge', 'ClearSignal', 'ByteForce'],
    adjectives: ['Wireless', 'Bluetooth', 'Smart', 'Ultra-Slim', 'Portable', 'Noise-Cancelling', 'Fast-Charging', 'HD'],
    nouns: ['Earbuds', 'Speaker', 'Charger', 'Power Bank', 'Webcam', 'Mouse', 'Keyboard', 'USB Hub', 'Monitor Stand', 'HDMI Cable'],
  },
  kitchen: {
    brands: ['ChefMaster', 'KitchenPro', 'CookCraft', 'BlendWell', 'FreshSeal', 'GrillKing', 'SlicePerfect', 'AromaBrew'],
    adjectives: ['Stainless Steel', 'Non-Stick', 'Dishwasher-Safe', 'BPA-Free', 'Premium', 'Professional', 'Insulated', 'Ergonomic'],
    nouns: ['Knife Set', 'Cutting Board', 'Blender', 'Air Fryer', 'Water Bottle', 'Storage Containers', 'Pan Set', 'Mixing Bowls', 'Coffee Maker', 'Spatula Set'],
  },
  beauty: {
    brands: ['GlowLab', 'PureSkin', 'LuxeBloom', 'VelvetTouch', 'AquaGlow', 'RadiantMe', 'SilkEssence', 'DewDrop'],
    adjectives: ['Organic', 'Hydrating', 'Anti-Aging', 'Brightening', 'Moisturizing', 'Natural', 'Vitamin C', 'Hyaluronic'],
    nouns: ['Face Serum', 'Moisturizer', 'Lip Balm', 'Hair Oil', 'Eye Cream', 'Sunscreen', 'Face Wash', 'Sheet Mask Set', 'Body Lotion', 'Makeup Remover'],
  },
  toys: {
    brands: ['PlayMakers', 'FunZone', 'ImagineToys', 'BrickWorld', 'PuzzleCraft', 'ToyVenture', 'KidGenius', 'StarPlay'],
    adjectives: ['Educational', 'Interactive', 'Light-Up', 'Magnetic', 'Wooden', 'Plush', 'Remote Control', 'Building'],
    nouns: ['Block Set', 'Puzzle', 'Action Figure', 'Board Game', 'Toy Car', 'Doll', 'Science Kit', 'Art Set', 'Dinosaur Set', 'Robot'],
  },
  sports: {
    brands: ['FitForge', 'TrailBlaze', 'IronGrip', 'FlexPeak', 'EnduroFit', 'CorePower', 'SprintEdge', 'AquaSport'],
    adjectives: ['Adjustable', 'Heavy-Duty', 'Lightweight', 'Foldable', 'Non-Slip', 'Breathable', 'Quick-Dry', 'Impact-Resistant'],
    nouns: ['Yoga Mat', 'Resistance Bands', 'Dumbbells', 'Jump Rope', 'Water Bottle', 'Gym Bag', 'Foam Roller', 'Running Belt', 'Exercise Ball', 'Pull-Up Bar'],
  },
  clothing: {
    brands: ['UrbanThread', 'CozyComfort', 'PrimeFit', 'SilkWear', 'FlexWrap', 'AirStep', 'NightBloom', 'EverWear'],
    adjectives: ['Cotton', 'Breathable', 'Stretch', 'Quick-Dry', 'Moisture-Wicking', 'Thermal', 'UV-Protection', 'Seamless'],
    nouns: ['T-Shirt Pack', 'Running Shoes', 'Socks (6-Pack)', 'Hoodie', 'Leggings', 'Baseball Cap', 'Winter Gloves', 'Sunglasses', 'Backpack', 'Watch Band'],
  },
  health: {
    brands: ['VitaCore', 'PureWell', 'NutriBlend', 'ZenHealth', 'LifeForce', 'MediClean', 'ProBio+', 'NaturalPath'],
    adjectives: ['High-Potency', 'Vegan', 'Time-Release', 'Doctor-Formulated', 'Sugar-Free', 'Organic', 'Cold-Pressed', 'Extra-Strength'],
    nouns: ['Multivitamin', 'Protein Powder', 'Probiotic', 'Fish Oil', 'Melatonin', 'Collagen Peptides', 'Electrolyte Powder', 'Hand Sanitizer', 'First Aid Kit', 'Thermometer'],
  },
  home: {
    brands: ['NestWell', 'CozySpace', 'HomeGlow', 'AuraLiving', 'CleanEdge', 'FreshAir', 'SoftTouch', 'LightHaven'],
    adjectives: ['Memory Foam', 'Bamboo', 'Blackout', 'Scented', 'Microfiber', 'LED', 'Cordless', 'Foldable'],
    nouns: ['Pillow (2-Pack)', 'Bed Sheets', 'Candle Set', 'Curtains', 'Desk Lamp', 'Throw Blanket', 'Hangers (50-Pack)', 'Shower Curtain', 'Area Rug', 'Storage Bins'],
  },
  books: {
    brands: ['BestRead', 'PageTurn', 'MindShift', 'StoryArk', 'DeepWrite', 'QuickRead', 'PenDragon', 'InkWell'],
    adjectives: ['Bestselling', 'Award-Winning', 'Illustrated', 'Revised Edition', 'Complete Guide', 'Ultimate', 'Comprehensive', 'Essential'],
    nouns: ['Self-Help Guide', 'Cookbook', 'Mystery Novel', 'Science Fiction', 'Business Strategy', 'Children\'s Book', 'Journal', 'Coloring Book', 'History Book', 'Memoir'],
  },
  grocery: {
    brands: ['NatureHarvest', 'SnackCraft', 'PurePantry', 'FreshFarm', 'GrainGood', 'CocoBite', 'SpiceWorld', 'MapleBrew'],
    adjectives: ['Organic', 'Gluten-Free', 'Keto-Friendly', 'Whole Grain', 'Sugar-Free', 'Fair Trade', 'Cold-Brew', 'Raw'],
    nouns: ['Protein Bars (12-Pack)', 'Mixed Nuts', 'Coffee Beans', 'Olive Oil', 'Dark Chocolate', 'Granola', 'Green Tea', 'Honey', 'Pasta Sauce', 'Trail Mix'],
  },
  office: {
    brands: ['DeskPro', 'WriteCraft', 'NeatDesk', 'PaperFlo', 'InkJet+', 'ClearView', 'FileMaster', 'ClipBoard'],
    adjectives: ['Heavy-Duty', 'Laminated', 'Refillable', 'Gel', 'Wide-Rule', 'Magnetic', 'Dry-Erase', 'Recycled'],
    nouns: ['Pen Set', 'Notebook (3-Pack)', 'Desk Organizer', 'Label Maker', 'Sticky Notes', 'Planner', 'File Folders', 'Stapler', 'Tape Dispenser', 'Whiteboard'],
  },
  petSupplies: {
    brands: ['PawPerfect', 'TailWag', 'FurFresh', 'PetJoy', 'NatureChew', 'AquaPet', 'SnugPet', 'FetchPro'],
    adjectives: ['Grain-Free', 'Automatic', 'Washable', 'Interactive', 'Orthopedic', 'Waterproof', 'Reflective', 'Biodegradable'],
    nouns: ['Dog Treats', 'Cat Litter', 'Pet Bed', 'Chew Toy', 'Water Fountain', 'Leash', 'Grooming Kit', 'Food Bowl', 'Cat Tree', 'Dog Shampoo'],
  },
  automotive: {
    brands: ['RoadReady', 'AutoShine', 'DrivePro', 'GearShift', 'MotorGuard', 'DashTech', 'TireForce', 'CleanDrive'],
    adjectives: ['Universal', 'Rain-Proof', 'Long-Lasting', 'Quick-Install', 'All-Weather', 'Heavy-Duty', 'Silicone', 'Ceramic'],
    nouns: ['Dash Cam', 'Floor Mats', 'Phone Mount', 'Car Charger', 'Air Freshener', 'Tire Inflator', 'Seat Covers', 'Wiper Blades', 'Jump Starter', 'Cleaning Kit'],
  },
  baby: {
    brands: ['TinyJoy', 'BabySoft', 'LittleStar', 'NurtureNest', 'GentleGrow', 'CuddlePlus', 'SafeStep', 'DreamBaby'],
    adjectives: ['Organic Cotton', 'BPA-Free', 'Hypoallergenic', 'Adjustable', 'Soft-Touch', 'Lightweight', 'Unscented', 'Eco-Friendly'],
    nouns: ['Diapers (Count 120)', 'Baby Wipes', 'Pacifier Set', 'Bottle Set', 'Teething Toy', 'Baby Monitor', 'Swaddle Blanket', 'High Chair', 'Stroller Organizer', 'Bath Toys'],
  },
  tools: {
    brands: ['BuildRight', 'PowerGrip', 'TorqueMaster', 'FixIt Pro', 'CraftForge', 'ToolEdge', 'DrillMax', 'LevelUp'],
    adjectives: ['Ratcheting', 'Cordless', 'LED-Lit', 'Magnetic', 'Impact-Rated', 'Titanium', 'Multi-Function', 'Precision'],
    nouns: ['Drill Bit Set', 'Screwdriver Kit', 'Tape Measure', 'Socket Set', 'Level', 'Utility Knife', 'Work Light', 'Pliers Set', 'Wrench Set', 'Tool Box'],
  },
  videogames: {
    brands: ['GameVault', 'PixelForge', 'NeonPlay', 'ControllerX', 'RetroArc', 'ProGamer', 'SteamDeck+', 'DualShock'],
    adjectives: ['Wireless', 'RGB', 'Ergonomic', 'Pro-Grade', 'Programmable', 'Surround Sound', '4K', 'Mechanical'],
    nouns: ['Controller', 'Gaming Headset', 'Mouse Pad XXL', 'Thumb Grips', 'Charging Dock', 'Controller Stand', 'HDMI Cable', 'Capture Card', 'Gaming Chair Cushion', 'Headset Stand'],
  },
};

// ─── ASIN Generator ─────────────────────────────────────────────────
function generateAsin(categoryIndex: number, productIndex: number): string {
  const prefix = 'B0';
  const payload = `${categoryIndex.toString(16).padStart(3, '0')}${productIndex.toString(16).padStart(5, '0')}`.toUpperCase();
  return `${prefix}${payload}`.slice(0, 10).padEnd(10, 'A');
}

// ─── Price Generator ────────────────────────────────────────────────
function generatePrice(category: string, rank: number): number {
  const basePrices: Record<string, [number, number]> = {
    electronics: [15, 200],
    kitchen: [8, 120],
    beauty: [6, 55],
    toys: [8, 80],
    sports: [10, 90],
    clothing: [10, 80],
    health: [8, 50],
    home: [10, 100],
    books: [8, 35],
    grocery: [5, 40],
    office: [5, 45],
    petSupplies: [6, 50],
    automotive: [10, 100],
    baby: [8, 70],
    tools: [10, 120],
    videogames: [12, 70],
  };
  const [min, max] = basePrices[category] || [10, 50];
  // Higher-ranked products tend to be mid-priced sweet spot
  const sweetSpot = min + (max - min) * 0.4;
  const variance = (max - min) * 0.3;
  return Math.round((sweetSpot + (Math.random() - 0.5) * variance) * 100) / 100;
}

// ─── Product Name Generator ─────────────────────────────────────────
function generateProductName(category: string, index: number): { title: string; brand: string } {
  const template = PRODUCT_TEMPLATES[category] || PRODUCT_TEMPLATES.electronics;
  const brand = template.brands[index % template.brands.length];
  const adj = template.adjectives[index % template.adjectives.length];
  const noun = template.nouns[index % template.nouns.length];
  // Mix it up with variation
  const variant = index > template.nouns.length
    ? ` — ${['Pro', 'Plus', 'Max', 'Lite', 'V2', 'XL', 'Mini', 'Elite'][index % 8]} Edition`
    : '';
  return {
    title: `${brand} ${adj} ${noun}${variant}`,
    brand,
  };
}

// ─── BSR Simulation Engine ──────────────────────────────────────────
/**
 * Simulates realistic BSR fluctuations over time.
 *
 * Real BSR behaviour observed on Amazon:
 * 1. Daily seasonality — sales peak in evening EST (~7-10pm), dip overnight
 * 2. Random walk — BSR drifts up/down with autocorrelation
 * 3. Occasional spikes — promotions, deals, or stockouts cause sharp rank jumps
 * 4. Mean-reversion — products tend to return to their "natural" rank
 * 5. Magnitude scaling — top-10 products fluctuate ±5%, BSR 100K fluctuates ±30%
 */
function simulateBsrTimeSeries(
  baseBsr: number,
  totalSnapshots: number,
  startTime: Date
): Array<{ time: Date; bsr: number }> {
  const snapshots: Array<{ time: Date; bsr: number }> = [];
  let currentBsr = baseBsr;

  for (let i = 0; i < totalSnapshots; i++) {
    const time = new Date(startTime.getTime() + i * SNAPSHOT_INTERVAL_HOURS * 60 * 60 * 1000);
    const hour = time.getUTCHours();

    // 1. Daily seasonality: BSR improves (drops) during peak hours
    const peakHour = 1; // ~8pm EST in UTC
    const hourDiff = Math.min(Math.abs(hour - peakHour), 24 - Math.abs(hour - peakHour));
    const seasonality = 1 + (hourDiff / 12) * 0.08; // ±8% over the day

    // 2. Random walk with autocorrelation
    const volatility = baseBsr < 100 ? 0.03 : baseBsr < 1000 ? 0.06 : baseBsr < 10000 ? 0.10 : 0.18;
    const randomShock = (Math.random() - 0.5) * 2 * volatility;

    // 3. Occasional spike (2% chance per snapshot)
    const spike = Math.random() < 0.02 ? (Math.random() - 0.4) * 0.5 : 0;

    // 4. Mean-reversion pull (pull back toward baseBsr)
    const meanReversion = (baseBsr - currentBsr) / baseBsr * 0.05;

    // 5. Weekly pattern: slightly worse BSR on weekdays
    const dayOfWeek = time.getUTCDay();
    const weekdayEffect = (dayOfWeek >= 1 && dayOfWeek <= 5) ? 1.02 : 0.97;

    // Combine effects
    currentBsr = currentBsr * (1 + randomShock + spike) * seasonality * weekdayEffect;
    currentBsr += currentBsr * meanReversion;

    // Clamp to realistic bounds
    const minBsr = Math.max(1, Math.round(baseBsr * 0.3));
    const maxBsr = Math.round(baseBsr * 3.0);
    currentBsr = Math.max(minBsr, Math.min(maxBsr, currentBsr));

    snapshots.push({
      time,
      bsr: Math.round(currentBsr),
    });
  }

  return snapshots;
}

// ─── Main Seeder ────────────────────────────────────────────────────
async function seedHistoricalData() {
  const prisma = new PrismaClient();

  try {
    console.log('');
    console.log('═'.repeat(60));
    console.log('  📊 Historical Data Seeder');
    console.log(`  📅 Generating ${SEED_DAYS} days of data`);
    console.log(`  ⏱️  Snapshot interval: every ${SNAPSHOT_INTERVAL_HOURS} hours`);
    console.log(`  📦 Products per category: ${PRODUCTS_PER_CATEGORY}`);
    console.log('═'.repeat(60));
    console.log('');

    const categories = Object.entries(CATEGORY_CURVES);
    const totalProducts = categories.length * PRODUCTS_PER_CATEGORY;
    const snapshotsPerProduct = Math.floor((SEED_DAYS * 24) / SNAPSHOT_INTERVAL_HOURS);
    const totalSnapshots = totalProducts * snapshotsPerProduct;

    console.log(`  📈 Total products to create: ${totalProducts}`);
    console.log(`  📸 Snapshots per product: ${snapshotsPerProduct}`);
    console.log(`  💾 Total snapshot rows: ${totalSnapshots.toLocaleString()}`);
    console.log('');

    const now = new Date();
    const startTime = new Date(now.getTime() - SEED_DAYS * 24 * 60 * 60 * 1000);

    let totalProductsSaved = 0;
    let totalSnapshotsSaved = 0;

    for (const [catIndex, [categoryKey, config]] of categories.entries()) {
      const catStart = Date.now();
      console.log(`\n🔄 [${catIndex + 1}/${categories.length}] ${config.displayName}`);

      // Generate products with realistic rank distribution
      // BSR follows a power law: most products are high-ranked, few are top sellers
      for (let pIdx = 0; pIdx < PRODUCTS_PER_CATEGORY; pIdx++) {
        const asin = generateAsin(catIndex, pIdx);

        // Power-law rank distribution: more products at higher (worse) BSR
        // Rank 1-10 for top 5%, 10-100 for next 15%, 100-5000 for next 40%, 5000+ rest
        let baseBsr: number;
        const roll = Math.random();
        if (roll < 0.05) {
          baseBsr = Math.ceil(Math.random() * 10);
        } else if (roll < 0.20) {
          baseBsr = Math.ceil(10 + Math.random() * 90);
        } else if (roll < 0.60) {
          baseBsr = Math.ceil(100 + Math.random() * 4900);
        } else if (roll < 0.85) {
          baseBsr = Math.ceil(5000 + Math.random() * 45000);
        } else {
          baseBsr = Math.ceil(50000 + Math.random() * 200000);
        }

        const price = generatePrice(categoryKey, baseBsr);
        const { title, brand } = generateProductName(categoryKey, pIdx);
        const imageUrl = `https://via.placeholder.com/200x200.png?text=${encodeURIComponent(categoryKey.slice(0, 4).toUpperCase())}+${pIdx + 1}`;

        // Upsert product
        await prisma.product.upsert({
          where: { asin_country: { asin, country: 'US' } },
          create: {
            asin,
            country: 'US',
            title,
            brand,
            imageUrl,
            productUrl: `https://www.amazon.com/dp/${asin}`,
            primaryCategory: categoryKey,
            priceUsd: price,
          },
          update: {
            title,
            brand,
            priceUsd: price,
            updatedAt: new Date(),
          },
        });
        totalProductsSaved++;

        // Generate BSR time series
        const bsrSeries = simulateBsrTimeSeries(baseBsr, snapshotsPerProduct, startTime);

        // Batch insert snapshots using raw SQL for speed
        for (let batchStart = 0; batchStart < bsrSeries.length; batchStart += BATCH_SIZE) {
          const batch = bsrSeries.slice(batchStart, batchStart + BATCH_SIZE);

          const values = batch.map(snap => {
            const estimate = estimateMonthlySales(snap.bsr, categoryKey, price);
            // Add small rating variation (3.5 - 4.9)
            const rating = (3.5 + Math.random() * 1.4).toFixed(2);
            // Review count grows slightly over time
            const baseReviews = Math.round(500 + Math.random() * 10000);
            const reviewGrowth = Math.round(baseReviews * 0.001 * (bsrSeries.indexOf(snap) / snapshotsPerProduct));
            const reviewCount = baseReviews + reviewGrowth;

            return `('${snap.time.toISOString()}', '${asin}', ${snap.bsr}, '${categoryKey}', ${reviewCount}, ${rating}, ${price}, ${estimate.estimatedMonthlySales}, ${estimate.estimatedMonthlyRevenue})`;
          }).join(',\n            ');

          await prisma.$executeRawUnsafe(`
            INSERT INTO bsr_snapshots (
              time, asin, bsr_category, category,
              review_count, rating, price_usd,
              estimated_monthly_sales, estimated_monthly_revenue
            ) VALUES
            ${values}
            ON CONFLICT DO NOTHING
          `);

          totalSnapshotsSaved += batch.length;
        }

        // Progress indicator
        if ((pIdx + 1) % 10 === 0) {
          process.stdout.write(`  ✅ ${pIdx + 1}/${PRODUCTS_PER_CATEGORY} products\r`);
        }
      }

      const catDuration = ((Date.now() - catStart) / 1000).toFixed(1);
      console.log(`  ✅ ${PRODUCTS_PER_CATEGORY} products seeded in ${catDuration}s`);
    }

    console.log('\n');
    console.log('═'.repeat(60));
    console.log(`  🎉 SEEDING COMPLETE!`);
    console.log(`  📦 Products created: ${totalProductsSaved}`);
    console.log(`  📸 Snapshots inserted: ${totalSnapshotsSaved.toLocaleString()}`);
    console.log(`  📅 Date range: ${startTime.toISOString().split('T')[0]} → ${now.toISOString().split('T')[0]}`);
    console.log('═'.repeat(60));
    console.log('');
    console.log('  Your dashboard should now show populated charts and trends!');
    console.log('  Start the backend: npm run dev');
    console.log('  Start the frontend: npm run dev (in packages/frontend)');
    console.log('');

  } catch (err) {
    console.error('\n💥 Seeding failed:', err);
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

seedHistoricalData().catch(console.error);
