function isUsableDatabaseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  if (s.includes('[YOUR-PASSWORD]') || s.includes('[YOUR-DATABASE-PASSWORD]')) return false;
  if (s.includes('<project-ref>') || s.includes('••••')) return false;
  try {
    const parsed = new URL(s);
    return (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') && Boolean(parsed.password);
  } catch {
    return false;
  }
}

let prismaInstance = null;

/**
 * Reports whether Prisma DATABASE_URL / DIRECT_URL are configured with real credentials.
 */
export function getPrismaStatus() {
  return {
    configured: isUsableDatabaseUrl(process.env.DATABASE_URL),
    directConfigured: isUsableDatabaseUrl(process.env.DIRECT_URL),
  };
}

/**
 * Lazily imports @prisma/client and returns a shared PrismaClient instance.
 * Keeps serverless cold starts fast and avoids crashing if Prisma engines are not generated.
 */
export async function getPrismaClient() {
  if (prismaInstance) return prismaInstance;
  if (!isUsableDatabaseUrl(process.env.DATABASE_URL)) {
    throw new Error(
      'DATABASE_URL is not configured with a valid password. Replace [YOUR-PASSWORD] in .env.local first.'
    );
  }
  const { PrismaClient } = await import('@prisma/client');
  prismaInstance = new PrismaClient();
  return prismaInstance;
}

/**
 * Gracefully disconnects Prisma on server shutdown.
 */
export async function disconnectPrisma() {
  if (!prismaInstance) return;
  const client = prismaInstance;
  prismaInstance = null;
  await client.$disconnect().catch(() => undefined);
}
