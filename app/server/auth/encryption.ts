import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * Chiffrement at-rest des mots de passe de proxy (AES-256-GCM) — pas un hash comme pour les mots
 * de passe utilisateur : on doit pouvoir RELIRE le mot de passe en clair pour le passer à
 * `DriverBuilder`/Playwright au lancement du navigateur, donc chiffrement réversible, pas hashing.
 * Clé dérivée de `PROXY_ENCRYPTION_KEY` (variable d'env) via scrypt — jamais la variable d'env
 * utilisée telle quelle comme clé brute.
 */
function resolveKey(): Buffer {
  const secret = process.env.PROXY_ENCRYPTION_KEY;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('PROXY_ENCRYPTION_KEY doit être défini en production.');
    }
    return scryptSync('dev-only-insecure-key', 'smonster-dev-salt', 32);
  }
  return scryptSync(secret, 'smonster-salt', 32);
}

const ALGO = 'aes-256-gcm';

/** Format stocké : `iv:authTag:ciphertext`, tout en hex — un seul champ texte en base. */
export function encryptSecret(plain: string): string {
  const key = resolveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptSecret(stored: string): string {
  const [ivHex, authTagHex, ciphertextHex] = stored.split(':');
  const key = resolveKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plain = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
  return plain.toString('utf8');
}
