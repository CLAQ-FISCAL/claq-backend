import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { AppError } from './http';

const kms = new KMSClient({});

/** Mozambique NUIT (Número Único de Identificação Tributária) is 9 digits. */
export const NUIT_RE = /^\d{9}$/;

export async function sealValue(plaintext: string): Promise<Buffer> {
  const keyId = process.env.KMS_KEY_ID;
  if (!keyId) throw new AppError(500, 'KMS_NOT_CONFIGURED', 'Encryption key is not configured.');
  const out = await kms.send(new EncryptCommand({ KeyId: keyId, Plaintext: Buffer.from(plaintext, 'utf8') }));
  if (!out.CiphertextBlob) throw new AppError(500, 'KMS_ENCRYPT_FAILED', 'Encryption failed.');
  return Buffer.from(out.CiphertextBlob);
}

export async function openValue(ciphertext: Buffer): Promise<string> {
  const keyId = process.env.KMS_KEY_ID;
  if (!keyId) throw new AppError(500, 'KMS_NOT_CONFIGURED', 'Encryption key is not configured.');
  const out = await kms.send(new DecryptCommand({ KeyId: keyId, CiphertextBlob: ciphertext }));
  if (!out.Plaintext) throw new AppError(500, 'KMS_DECRYPT_FAILED', 'Decryption failed.');
  return Buffer.from(out.Plaintext).toString('utf8');
}

export function maskNuit(nuit: string): string {
  return `***${nuit.slice(-3)}`;
}
