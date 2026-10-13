import Stripe from 'stripe';
import { db } from '../lib/db';
import { defaultPlanForFamily } from '../lib/plans';
import { findTenantByStripeCustomer, handleInvoiceEvent, registerPrice, syncStripeSubscription } from './stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', { apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion });

// STRIPE_PRICES is a JSON object mapping plan code -> Stripe price id, e.g.
// { "ACCOUNTANT_PRO": "price_...", "COMPANY_PEQUENA": "price_..." }
const PLAN_PRICE_IDS: Record<string, string> = (() => {
  try {
    const parsed = JSON.parse(process.env.STRIPE_PRICES ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''));
  } catch {
    return {};
  }
})();

for (const [plan, priceId] of Object.entries(PLAN_PRICE_IDS)) {
  if (priceId) registerPrice(priceId, plan);
}

function getPlanForPrice(priceId: string): string {
  for (const [plan, pid] of Object.entries(PLAN_PRICE_IDS)) {
    if (pid === priceId) return plan;
  }
  return 'ACCOUNTANT_FREE';
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
      const tenant = await findTenantByStripeCustomer(db, sub.customer as string);
      if (!tenant) return { status: 200, message: 'No tenant found for customer — skipped.' };
      const priceId = sub.items.data[0]?.price?.id ?? '';
      const plan = getPlanForPrice(priceId);
      registerPrice(priceId, plan);
      await syncStripeSubscription(db, tenant.id, {
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
      const tenant = await findTenantByStripeCustomer(db, sub.customer as string);
      if (!tenant) return { status: 200, message: 'No tenant — skipped.' };
      await db.billingSubscription.updateMany({
        where: { stripeSubscriptionId: sub.id },
        data: { status: 'canceled' },
      });
      await db.tenant.update({ where: { id: tenant.id }, data: { plan: defaultPlanForFamily(tenant.type) } });
      return { status: 200, message: 'Subscription deleted, plan downgraded.' };
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const inv = event.data.object as Stripe.Invoice;
      const tenant = await findTenantByStripeCustomer(db, inv.customer as string);
      if (!tenant) return { status: 200, message: 'No tenant — skipped.' };
      await handleInvoiceEvent(db, tenant.id, {
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
