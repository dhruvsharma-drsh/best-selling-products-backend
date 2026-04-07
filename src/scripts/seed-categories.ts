import '../config/env.js';
import { Prisma, PrismaClient } from '@prisma/client';
import { CATEGORY_CURVES } from '../estimation/category-curves.js';

/**
 * Seeds the category_curves table with all BSR reference data.
 * Run once after database init: pnpm seed
 */
async function seedCategories() {
  const prisma = new PrismaClient();

  try {
    console.log('🌱 Seeding category curves...\n');

    for (const [key, config] of Object.entries(CATEGORY_CURVES)) {
      await prisma.categoryCurve.upsert({
        where: { category: key },
        create: {
          category: key,
          displayName: config.displayName,
          amazonUrl: config.amazonUrl,
          referencePoints: config.referencePoints as unknown as Prisma.InputJsonValue,
          totalProductsEstimate: config.totalProductsEstimate,
        },
        update: {
          displayName: config.displayName,
          amazonUrl: config.amazonUrl,
          referencePoints: config.referencePoints as unknown as Prisma.InputJsonValue,
          totalProductsEstimate: config.totalProductsEstimate,
          lastCalibrated: new Date(),
        },
      });

      console.log(`  ✅ ${config.displayName} (${config.referencePoints.length} reference points)`);
    }

    console.log(`\n🎉 Seeded ${Object.keys(CATEGORY_CURVES).length} category curves`);
  } finally {
    await prisma.$disconnect();
  }
}

seedCategories().catch(console.error);
