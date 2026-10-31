import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { deriveSecret } from './jwt';

/**
 * Chiffrement at-rest du secret TOTP (AES-256-GCM, même algo que `encryption.ts` pour les mots de
 * passe de proxy) — mais dans son PROPRE espace de clé (dérivé de `JWT_SECRET` via `deriveSecret`,
 * jamais `PROXY_ENCRYPTION_KEY` : un secret TOTP et un mot de passe de proxy n'ont rien à voir,
 * compromettre l'un ne doit jamais exposer l'autre).
 */
const ALGO = 'aes-256-gcm';
const KEY = () => deriveSecret('totp-secret-v1');

export function sealTotpSecret(secretBase32: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, KEY(), iv);
  const ciphertext = Buffer.concat([cipher.update(secretBase32, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function unsealTotpSecret(sealed: string): string {
  const [ivHex, authTagHex, ciphertextHex] = sealed.split(':');
  const decipher = createDecipheriv(ALGO, KEY(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plain = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
  return plain.toString('utf8');
}

/** `null` plutôt qu'une exception brute (clé GCM invalide -> `Decipheriv.final()` throw) — ex.
 * `JWT_SECRET` changé entre le scellement et maintenant (rotation de secret, migration...). Un
 * appelant HTTP doit pouvoir traiter ça comme "code invalide" sans jamais laisser fuiter un
 * message d'erreur crypto interne au client. */
export function tryUnsealTotpSecret(sealed: string): string | null {
  try {
    return unsealTotpSecret(sealed);
  } catch {
    return null;
  }
}
