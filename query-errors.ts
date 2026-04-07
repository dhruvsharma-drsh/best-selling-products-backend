import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.scrapeJob.findMany({
    orderBy: {
      createdAt: 'desc',
    },
    take: 50,
  });

  fs.writeFileSync('output.json', JSON.stringify(jobs, null, 2));
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
