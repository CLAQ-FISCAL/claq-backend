import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

let cached: { phoneNumberId: string; accessToken: string } | null = null;

async function loadSecrets(): Promise<{ phoneNumberId: string; accessToken: string }> {
  if (cached) return cached;
  const secretArn = process.env.WHATSAPP_SECRET_ARN;
  if (!secretArn) throw new Error('WHATSAPP_SECRET_ARN is not configured');
  const client = new SecretsManagerClient({});
  const resp = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!resp.SecretString) throw new Error('WhatsApp secret has no SecretString');
  const parsed = JSON.parse(resp.SecretString) as { phoneNumberId: string; accessToken: string };
  cached = { phoneNumberId: parsed.phoneNumberId, accessToken: parsed.accessToken };
  return cached;
}

export type WhatsAppResult = { success: boolean; messageId?: string; error?: string };

export async function sendWhatsAppMessage(phone: string, body: string): Promise<WhatsAppResult> {
  try {
    const { phoneNumberId, accessToken } = await loadSecrets();
    const normalized = phone.replace(/[^\d]/g, '');
    const response = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: normalized, type: 'text', text: { body } }),
    });
    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `WhatsApp API ${response.status}: ${text.slice(0, 200)}` };
    }
    const data = (await response.json()) as { messages?: { id: string }[] };
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function buildWhatsAppText(n: { title: string; companyLegalName: string; dueAt: Date; leadDay: number; status: string; demo: boolean }): string {
  const due = n.dueAt.toISOString().slice(0, 10);
  const timing = n.leadDay === -1 || n.status === 'OVERDUE'
    ? '⚠️ VENCIDA — regularize o mais breve.'
    : n.leadDay === 0
      ? '⏰ Vence HOJE.'
      : `Vence em ${n.leadDay} dia(s).`;
  const banner = n.demo ? '\n\n_AMI DEMONSTRAÇÃO — sem valor oficial._' : '';
  return `CLAQ Fiscal Alert — ${n.companyLegalName}\n\n${n.title}\nPrazo: ${due}\n${timing}${banner}`;
}
