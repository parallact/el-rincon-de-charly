import { PrismaClient } from '@/generated/prisma';
import { PrismaPg } from '@prisma/adapter-pg';

// Neon (Postgres) via the pg driver adapter. All DB access runs server-side.
const connectionString = process.env.DATABASE_URL;
const adapter = new PrismaPg({ connectionString: connectionString ?? '' });

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
