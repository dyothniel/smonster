import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  isSuperAdmin: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  // 2FA — cf. app/server/auth/{totp,totpSecretBox,emailCodes}.ts. `totpSecretEnc` est posé par
  // `/account/totp/setup` avant même que `totpEnabledAt` soit set : seule sa présence ET
  // `totpEnabledAt` non-null signifient "2FA active" (cf. authRouter.ts, login).
  totpSecretEnc: string | null;
  totpEnabledAt: string | null;
  totpLastStep: number | null;
  emailOtpEnabled: boolean;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  is_super_admin: number;
  is_active: number;
  created_at: string;
  updated_at: string;
  totp_secret_enc: string | null;
  totp_enabled_at: string | null;
  totp_last_step: number | null;
  email_otp_enabled: number;
}

function fromRow(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    isSuperAdmin: row.is_super_admin === 1,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    totpSecretEnc: row.totp_secret_enc,
    totpEnabledAt: row.totp_enabled_at,
    totpLastStep: row.totp_last_step,
    emailOtpEnabled: row.email_otp_enabled === 1,
  };
}

export class UserRepository {
  constructor(private readonly db: Database) {}

  findByEmail(email: string): UserRecord | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  findById(id: string): UserRecord | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  create(input: { email: string; passwordHash: string; displayName: string; isSuperAdmin?: boolean }): UserRecord {
    const now = new Date().toISOString();
    const record: UserRecord = {
      id: randomUUID(),
      email: input.email,
      passwordHash: input.passwordHash,
      displayName: input.displayName,
      isSuperAdmin: input.isSuperAdmin ?? false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      totpSecretEnc: null,
      totpEnabledAt: null,
      totpLastStep: null,
      emailOtpEnabled: false,
    };
    this.db
      .prepare(
        `INSERT INTO users (id, email, password_hash, display_name, is_super_admin, is_active, created_at, updated_at)
         VALUES (@id, @email, @passwordHash, @displayName, @isSuperAdmin, @isActive, @createdAt, @updatedAt)`
      )
      .run({ ...record, isSuperAdmin: record.isSuperAdmin ? 1 : 0, isActive: record.isActive ? 1 : 0 });
    return record;
  }

  updateDisplayName(id: string, displayName: string): void {
    this.db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?').run(displayName, new Date().toISOString(), id);
  }

  updatePasswordHash(id: string, passwordHash: string): void {
    this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(passwordHash, new Date().toISOString(), id);
  }

  /** Pose le secret (scellé) SANS activer la 2FA — `enableTotp` confirme après vérif du 1er code. */
  setPendingTotpSecret(id: string, sealedSecret: string): void {
    this.db.prepare('UPDATE users SET totp_secret_enc = ?, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ?').run(sealedSecret, id);
  }

  enableTotp(id: string): void {
    this.db.prepare('UPDATE users SET totp_enabled_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  disableTotp(id: string): void {
    this.db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ?').run(id);
  }

  setTotpLastStep(id: string, step: number): void {
    this.db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, id);
  }

  setEmailOtpEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE users SET email_otp_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }
}
