import { MembershipRole, Prisma, PrismaClient } from '@prisma/client';
import { AppError } from './http';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TenantContext = {
  userId: string;
  tenantId: string;
  role: MembershipRole;
  tenant: { id: string; name: string; plan: string };
  plan: string;
};

/**
 * Runs `fn` inside a transaction with app.tenant_id set (RLS context).
 * FORCE ROW LEVEL SECURITY makes every tenant table default-deny:
 * without this wrapper, queries return zero rows and writes are rejected.
 */
export async function withTenant<T>(prisma: PrismaClient, tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new AppError(403, 'TENANT_ACCESS_DENIED', 'Invalid tenant identifier.');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

/** Lazily provisions the User row from verified Cognito claims (never from request body). */
export async function ensureUser(prisma: PrismaClient, claims: Record<string, unknown>): Promise<{ id: string; email: string; displayName: string | null }> {
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  if (!sub) throw new AppError(401, 'UNAUTHENTICATED', 'Missing token subject.');
  const email = typeof claims.email === 'string' && claims.email.includes('@') ? claims.email : `${sub}@no-email.invalid`;
  const displayName = typeof claims.name === 'string' && claims.name.trim() !== '' ? claims.name.trim() : undefined;
  return prisma.user.upsert({
    where: { cognitoSub: sub },
    update: { displayName },
    create: { cognitoSub: sub, email, displayName },
  });
}

/**
 * Resolves the working tenant server-side. A tenant id from the frontend is only a
 * selector: authorization always comes from the Membership table (README guardrail).
 */
export async function resolveTenant(prisma: PrismaClient, userId: string, headerTenantId: string | undefined): Promise<TenantContext> {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: { tenant: { select: { id: true, name: true, plan: true } } },
    orderBy: { tenant: { name: 'asc' } },
  });
  if (memberships.length === 0) throw new AppError(403, 'NO_TENANT', 'This account has no tenant membership yet. Ask your administrator for an invitation.');
  let membership = memberships[0];
  if (headerTenantId !== undefined) {
    const found = memberships.find((m) => m.tenantId === headerTenantId);
    if (!found) throw new AppError(403, 'TENANT_ACCESS_DENIED', 'You are not a member of the requested tenant.');
    membership = found;
  } else if (memberships.length > 1) {
    throw new AppError(400, 'TENANT_REQUIRED', 'Account belongs to multiple tenants. Send the X-Tenant-Id header.');
  }
  return { userId, tenantId: membership.tenantId, role: membership.role, tenant: membership.tenant, plan: membership.tenant.plan };
}
