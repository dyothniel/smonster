import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface EmailCodeRecord {
  id: string;
  userId: string;
  codeHash: string;
  attempts: number;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

interface EmailCodeRow {
  id: string;
  user_id: string;
  code_hash: string;
  attempts: number;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

function fromRow(row: EmailCodeRow): EmailCodeRecord {
  return {
    id: row.id,
    userId: row.user_id,
    codeHash: row.code_hash,
    attempts: row.attempts,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

export class EmailCodeRepository {
  constructor(private readonly db: Database) {}

  create(userId: string, codeHash: string, ttlMs: number): EmailCodeRecord {
    const now = new Date();
    const record: EmailCodeRecord = {
      id: randomUUID(),
      userId,
      codeHash,
      attempts: 0,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      consumedAt: null,
      createdAt: now.toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO email_codes (id, user_id, code_hash, attempts, expires_at, consumed_at, created_at)
         VALUES (@id, @userId, @codeHash, @attempts, @expiresAt, @consumedAt, @createdAt)`
      )
      .run(record);
    return record;
  }

  /** Le code le plus récent, non consommé et non expiré, pour cet utilisateur — `undefined` sinon. */
  findLatestPending(userId: string): EmailCodeRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM email_codes WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(userId, new Date().toISOString()) as EmailCodeRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  incrementAttempts(id: string): void {
    this.db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').run(id);
  }

  consume(id: string): void {
    this.db.prepare('UPDATE email_codes SET consumed_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }
}
