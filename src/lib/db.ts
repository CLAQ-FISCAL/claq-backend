import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { claqPrisma?: PrismaClient };

export const db: PrismaClient =
  globalForPrisma.claqPrisma ??
  new PrismaClient({
    log: process.env.APP_ENV === 'demo' ? [{ emit: 'stdout', level: 'error' }] : [{ emit: 'stdout', level: 'error' }],
  });

globalForPrisma.claqPrisma = db;
