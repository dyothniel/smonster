import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { encryptSecret, decryptSecret } from '../auth/encryption';

export interface ProxyRecord {
  id: string;
  teamId: string;
  label: string;
  server: string;
  username: string | null;
  password: string | null; // déchiffré, jamais stocké tel quel en base (cf. password_encrypted)
  bypass: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProxyInput {
  label: string;
  server: string;
  username?: string | null;
  password?: string | null;
  bypass?: string | null;
}

interface ProxyRow {
  id: string;
  team_id: string;
  label: string;
  server: string;
  username: string | null;
  password_encrypted: string | null;
  bypass: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function fromRow(row: ProxyRow): ProxyRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    label: row.label,
    server: row.server,
    username: row.username,
    password: row.password_encrypted ? decryptSecret(row.password_encrypted) : null,
    bypass: row.bypass,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProxyRepository {
  constructor(private readonly db: Database) {}

  list(teamId: string): ProxyRecord[] {
    const rows = this.db.prepare('SELECT * FROM proxies WHERE team_id = ?').all(teamId) as ProxyRow[];
    return rows.map(fromRow);
  }

  get(teamId: string, id: string): ProxyRecord | undefined {
    const row = this.db.prepare('SELECT * FROM proxies WHERE team_id = ? AND id = ?').get(teamId, id) as ProxyRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  create(teamId: string, createdBy: string, input: CreateProxyInput): ProxyRecord {
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      team_id: teamId,
      label: input.label,
      server: input.server,
      username: input.username ?? null,
      password_encrypted: input.password ? encryptSecret(input.password) : null,
      bypass: input.bypass ?? null,
      created_by: createdBy,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO proxies (id, team_id, label, server, username, password_encrypted, bypass, created_by, created_at, updated_at)
         VALUES (@id, @team_id, @label, @server, @username, @password_encrypted, @bypass, @created_by, @created_at, @updated_at)`
      )
      .run(row);
    return fromRow(row);
  }

  update(teamId: string, id: string, patch: Partial<CreateProxyInput>): ProxyRecord {
    const existing = this.get(teamId, id);
    if (!existing) {
      throw new Error(`ProxyRepository: proxy inconnu dans cette team: ${id}`);
    }
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        `UPDATE proxies SET label = ?, server = ?, username = ?, password_encrypted = ?, bypass = ?, updated_at = ?
         WHERE team_id = ? AND id = ?`
      )
      .run(
        updated.label,
        updated.server,
        updated.username,
        updated.password ? encryptSecret(updated.password) : null,
        updated.bypass,
        updated.updatedAt,
        teamId,
        id
      );
    return updated;
  }

  remove(teamId: string, id: string): void {
    this.db.prepare('DELETE FROM proxies WHERE team_id = ? AND id = ?').run(teamId, id);
  }
}
