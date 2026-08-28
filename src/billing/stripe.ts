import { PrismaClient } from '@prisma/client';

export type PlanMapping = { planCode: string };

const priceMap: Record<string, PlanMapping> = {};

export function registerPrice(priceId: string, planCode: string): void {
  priceMap[priceId] = { planCode };
}

export function resolvePlanFromPrice(priceId: string): PlanMapping | null {
  return priceMap[priceId] ?? null;
}

export async function syncStripeSubscription(
  prisma: PrismaClient,
  tenantId: string,
  args: {
    stripeCustomerId: string;
    stripeSubscriptionId: string;
    status: string;
    priceId: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
  },
): Promise<{ plan: string }> {
  const mapping = resolvePlanFromPrice(args.priceId);
  const plan = mapping?.planCode ?? 'ACCOUNTANT_OFFICE';

  await prisma.$transaction(async (tx) => {
    await tx.tenant.upsert({
      where: { id: tenantId },
      update: { stripeCustomerId: args.stripeCustomerId },
      create: { name: `Tenant ${tenantId.slice(0, 8)}`, plan: 'ACCOUNTANT_OFFICE', stripeCustomerId: args.stripeCustomerId },
    });

    await tx.billingSubscription.upsert({
      where: { stripeSubscriptionId: args.stripeSubscriptionId },
      update: {
        status: args.status,
        priceId: args.priceId,
        currentPeriodStart: args.currentPeriodStart,
        currentPeriodEnd: args.currentPeriodEnd,
        cancelAtPeriodEnd: args.cancelAtPeriodEnd,
      },
      create: {
        tenantId,
        stripeCustomerId: args.stripeCustomerId,
        stripeSubscriptionId: args.stripeSubscriptionId,
        status: args.status,
        priceId: args.priceId,
        currentPeriodStart: args.currentPeriodStart,
        currentPeriodEnd: args.currentPeriodEnd,
        cancelAtPeriodEnd: args.cancelAtPeriodEnd,
      },
    });

    if (args.status === 'active') {
      await tx.tenant.update({ where: { id: tenantId }, data: { plan } });
    }
  });

  return { plan };
}

export async function handleInvoiceEvent(
  prisma: PrismaClient,
  tenantId: string,
  args: {
    stripeInvoiceId: string;
    amountDue: number;
    currency: string;
    status: string;
    invoicePdfUrl?: string;
    hostedInvoiceUrl?: string;
  },
): Promise<void> {
  await prisma.invoice.upsert({
    where: { stripeInvoiceId: args.stripeInvoiceId },
    update: { status: args.status, amountDue: args.amountDue, invoicePdfUrl: args.invoicePdfUrl, hostedInvoiceUrl: args.hostedInvoiceUrl },
    create: {
      tenantId,
      stripeInvoiceId: args.stripeInvoiceId,
      amountDue: args.amountDue,
      currency: args.currency,
      status: args.status,
      invoicePdfUrl: args.invoicePdfUrl,
      hostedInvoiceUrl: args.hostedInvoiceUrl,
    },
  });
}

export async function findTenantByStripeCustomer(prisma: PrismaClient, stripeCustomerId: string): Promise<string | null> {
  const tenant = await prisma.tenant.findUnique({ where: { stripeCustomerId }, select: { id: true } });
  return tenant?.id ?? null;
}
