import Stripe from 'stripe';
import { db } from '../lib/db';
import { findTenantByStripeCustomer, handleInvoiceEvent, registerPrice, syncStripeSubscription } from './stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', { apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion });

const PLAN_PRICE_IDS: Record<string, string> = {
  ACCOUNTANT_OFFICE: process.env.STRIPE_PRICE_ACCOUNTANT_OFFICE ?? '',
  PME_CORPORATE: process.env.STRIPE_PRICE_PME_CORPORATE ?? '',
};

for (const [plan, priceId] of Object.entries(PLAN_PRICE_IDS)) {
  if (priceId) registerPrice(priceId, plan);
}

function getPlanForPrice(priceId: string): string {
  for (const [plan, pid] of Object.entries(PLAN_PRICE_IDS)) {
    if (pid === priceId) return plan;
  }
  return 'ACCOUNTANT_OFFICE';
}

export async function handleStripeWebhook(body: string, signature: string): Promise<{ status: number; message: string }> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    return { status: 400, message: `Signature verification failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription & { current_period_start: number; current_period_end: number };
      const tenantId = await findTenantByStripeCustomer(db, sub.customer as string);
      if (!tenantId) return { status: 200, message: 'No tenant found for customer — skipped.' };
      const priceId = sub.items.data[0]?.price?.id ?? '';
      const plan = getPlanForPrice(priceId);
      registerPrice(priceId, plan);
      await syncStripeSubscription(db, tenantId, {
        stripeCustomerId: sub.customer as string,
        stripeSubscriptionId: sub.id,
        status: sub.status,
        priceId,
        currentPeriodStart: new Date(sub.current_period_start * 1000),
        currentPeriodEnd: new Date(sub.current_period_end * 1000),
        cancelAtPeriodEnd: sub.cancel_at_period_end,
      });
      return { status: 200, message: `Subscription ${event.type} synced.` };
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const tenantId = await findTenantByStripeCustomer(db, sub.customer as string);
      if (!tenantId) return { status: 200, message: 'No tenant — skipped.' };
      await db.billingSubscription.updateMany({
        where: { stripeSubscriptionId: sub.id },
        data: { status: 'canceled' },
      });
      await db.tenant.update({ where: { id: tenantId }, data: { plan: 'PME_CORPORATE' } });
      return { status: 200, message: 'Subscription deleted, plan downgraded.' };
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const inv = event.data.object as Stripe.Invoice;
      const tenantId = await findTenantByStripeCustomer(db, inv.customer as string);
      if (!tenantId) return { status: 200, message: 'No tenant — skipped.' };
      await handleInvoiceEvent(db, tenantId, {
        stripeInvoiceId: inv.id,
        amountDue: inv.amount_due,
        currency: inv.currency,
        status: inv.status ?? 'unknown',
        invoicePdfUrl: inv.invoice_pdf ?? undefined,
        hostedInvoiceUrl: inv.hosted_invoice_url ?? undefined,
      });
      return { status: 200, message: `Invoice ${event.type} recorded.` };
    }
    default:
      return { status: 200, message: `Unhandled event type: ${event.type}` };
  }
}
