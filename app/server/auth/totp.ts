import { createHmac, randomBytes } from 'crypto';

/**
 * TOTP (RFC 6238) écrit à la main plutôt qu'une dépendance externe — l'algorithme tient en une
 * poignée de lignes avec juste `crypto` natif (HOTP = HMAC-SHA1 sur un compteur, cf. RFC 4226),
 * pas besoin d'une lib tierce pour ça. Compatible avec toutes les apps d'authentification usuelles
 * (Google Authenticator, Authy, 1Password...) : SHA-1, 6 chiffres, pas de 30s — les valeurs par
 * défaut que ces apps supposent déjà quand elles scannent un QR sans paramètres explicites.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20)); // 160 bits, la taille de bloc attendue par HMAC-SHA1
}

function hotp(secret: Buffer, counter: number): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return (code % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
}

function currentStep(): number {
  return Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * Fenêtre de tolérance ±1 pas (30s) pour absorber la dérive d'horloge normale entre le téléphone
 * et ce serveur. `lastAcceptedStep` bloque le replay (cf. `users.totp_last_step`) : un pas déjà
 * validé — même dans la fenêtre — ne peut plus jamais être réutilisé.
 */
export function verifyTotp(secretBase32: string, code: string, lastAcceptedStep: number | null): { valid: boolean; step: number } {
  const step = currentStep();
  if (!/^\d{6}$/.test(code)) return { valid: false, step };
  const secret = base32Decode(secretBase32);
  for (const delta of [0, -1, 1]) {
    const candidateStep = step + delta;
    if (lastAcceptedStep !== null && candidateStep <= lastAcceptedStep) continue;
    if (hotp(secret, candidateStep) === code) return { valid: true, step: candidateStep };
  }
  return { valid: false, step };
}

export function buildTotpUri(secretBase32: string, email: string): string {
  const label = encodeURIComponent(`smonster:${email}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=smonster&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}
