import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  deviceLabel: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export class RefreshTokenRepository {
  constructor(private readonly db: Database) {}

  create(userId: string, tokenHash: string, deviceLabel: string | null): RefreshTokenRecord {
    const now = new Date();
    const record: RefreshTokenRecord = {
      id: randomUUID(),
      userId,
      tokenHash,
      deviceLabel,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
      revokedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, device_label, created_at, expires_at, revoked_at)
         VALUES (@id, @userId, @tokenHash, @deviceLabel, @createdAt, @expiresAt, @revokedAt)`
      )
      .run(record);
    return record;
  }

  /** `undefined` si le hash est inconnu, révoqué, ou expiré — jamais d'exception. */
  findValid(tokenHash: string): RefreshTokenRecord | undefined {
    const row = this.db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(tokenHash) as
      | { id: string; user_id: string; token_hash: string; device_label: string | null; created_at: string; expires_at: string; revoked_at: string | null }
      | undefined;
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() < Date.now()) return undefined;
    return {
      id: row.id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      deviceLabel: row.device_label,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  }

  /** Révocation : utilisée à la fois pour le logout explicite ET pour la rotation à chaque refresh (cf. auth/middleware.ts). */
  revoke(id: string): void {
    this.db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  revokeAllForUser(userId: string): void {
    this.db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(new Date().toISOString(), userId);
  }
}
