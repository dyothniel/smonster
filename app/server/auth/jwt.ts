import jwt from 'jsonwebtoken';
import { randomBytes, createHash, hkdfSync } from 'crypto';

export type MembershipRole = 'TEAM_ADMIN' | 'MEMBER';

export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
  displayName: string;
  isSuperAdmin: boolean;
  teams: { teamId: string; role: MembershipRole }[];
}

// `teams` embarqué dans le token : évite une lecture DB à chaque appel API/handshake WS pour
// savoir à quelles teams l'utilisateur appartient. Conséquence acceptée : un changement de rôle
// ou de team ne prend effet qu'au prochain refresh (access token court, ~15 min — cf. ACCESS_TOKEN_TTL).
const ACCESS_TOKEN_TTL = '15m';

// Pas de secret par défaut en production : une valeur JWT devinable casserait toute la sécurité
// de l'authentification. En dev/test, un secret aléatoire par process suffit (les tokens ne
// doivent survivre qu'à la durée du process de test) — évite d'exiger une variable d'env pour
// lancer les tests locaux tout en ne laissant jamais passer un secret faible en prod.
function resolveJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET doit être défini en production (jamais de valeur par défaut ici).');
  }
  return randomBytes(32).toString('hex');
}
const JWT_SECRET = resolveJwtSecret();

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

/** `null` si le token est invalide/expiré — jamais une exception à charge de l'appelant. */
export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AccessTokenPayload;
  } catch {
    return null;
  }
}

/**
 * Refresh token : une chaîne aléatoire opaque (pas un JWT) — on le stocke déjà hashé côté
 * serveur pour pouvoir le révoquer individuellement (`refresh_tokens`), donc un JWT signé
 * n'apporterait rien de plus qu'un secret aléatoire à haute entropie. Hashé en SHA-256 (pas
 * argon2 : ce n'est pas un mot de passe choisi par un humain à faible entropie, pas besoin d'un
 * hash volontairement lent).
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('hex');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Dérive une clé indépendante à partir de `JWT_SECRET` (HKDF, un `info` distinct par usage) —
 * évite d'exiger une nouvelle variable d'env à chaque nouveau besoin de chiffrement/HMAC (2FA...),
 * tout en gardant chaque usage dans son propre espace de clé (un `info` différent de celui d'un
 * autre module ne peut jamais produire la même clé, même à partir du même secret racine).
 */
export function deriveSecret(info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', JWT_SECRET, 'smonster-hkdf-salt', info, 32));
}

export interface MfaChallengePayload {
  sub: string; // user id
  method: 'totp' | 'email';
}

// Court délibérément : le temps de taper un code à 6 chiffres, pas une session — cf. login/verify.
const MFA_CHALLENGE_TTL = '10m';

/** Jeton de défi 2FA entre `/login` et `/login/verify` — pas de cookie (client lourd, pas de
 * navigateur) : transporté tel quel dans la réponse JSON puis renvoyé par le client. */
export function signChallengeToken(payload: MfaChallengePayload): string {
  return jwt.sign({ ...payload, typ: 'mfa_challenge' }, JWT_SECRET, { expiresIn: MFA_CHALLENGE_TTL });
}

export function verifyChallengeToken(token: string): MfaChallengePayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload & { typ?: string; method?: string };
    if (decoded.typ !== 'mfa_challenge' || typeof decoded.sub !== 'string') return null;
    if (decoded.method !== 'totp' && decoded.method !== 'email') return null;
    return { sub: decoded.sub, method: decoded.method };
  } catch {
    return null;
  }
}
