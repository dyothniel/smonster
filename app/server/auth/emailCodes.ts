import { createHmac, randomInt } from 'crypto';
import { deriveSecret } from './jwt';

export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;

export function generateEmailCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Seul le hash est stocké (`email_codes.code_hash`) — jamais le code en clair, cf. table dédiée. */
export function hashEmailCode(code: string): string {
  return createHmac('sha256', deriveSecret('email-otp-v1')).update(code).digest('hex');
}
