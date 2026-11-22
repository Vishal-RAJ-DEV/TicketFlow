const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { config } = require('./');

const globalForPrisma = global;

if (!globalForPrisma.eventPrisma) {
  const adapter = new PrismaPg({ connectionString: config.DATABASE_URL });
  globalForPrisma.eventPrisma = new PrismaClient({
    adapter,
    log: ['error', 'warn'],
  });
}

module.exports = globalForPrisma.eventPrisma;