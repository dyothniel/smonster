import * as argon2 from 'argon2';

/**
 * argon2id (le variant recommandé par défaut par la lib elle-même — résistant aux attaques GPU
 * ET side-channel, contrairement à argon2i/argon2d pris isolément) pour le hashing de mot de
 * passe côté serveur. Paramètres par défaut de la lib : raisonnables pour un service de cette
 * taille, pas besoin de les retoucher ici.
 */
export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}
