import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface ProfileRecord {
  id: string;
  teamId: string;
  name: string;
  device: string;
  locale: string;
  timezoneId: string;
  headlessDefault: boolean;
  proxyId: string | null;
  stateVersion: number;
  stateUpdatedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProfileInput {
  name: string;
  device?: string;
  locale?: string;
  timezoneId?: string;
  headlessDefault?: boolean;
  proxyId?: string | null;
}

interface ProfileRow {
  id: string;
  team_id: string;
  name: string;
  device: string;
  locale: string;
  timezone_id: string;
  headless_default: number;
  proxy_id: string | null;
  state_version: number;
  state_updated_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function fromRow(row: ProfileRow): ProfileRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    device: row.device,
    locale: row.locale,
    timezoneId: row.timezone_id,
    headlessDefault: row.headless_default === 1,
    proxyId: row.proxy_id,
    stateVersion: row.state_version,
    stateUpdatedAt: row.state_updated_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProfileRepository {
  constructor(private readonly db: Database) {}

  list(teamId: string): ProfileRecord[] {
    const rows = this.db.prepare('SELECT * FROM profiles WHERE team_id = ?').all(teamId) as ProfileRow[];
    return rows.map(fromRow);
  }

  get(teamId: string, id: string): ProfileRecord | undefined {
    const row = this.db.prepare('SELECT * FROM profiles WHERE team_id = ? AND id = ?').get(teamId, id) as ProfileRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  create(teamId: string, createdBy: string, input: CreateProfileInput): ProfileRecord {
    const now = new Date().toISOString();
    const row: ProfileRow = {
      id: randomUUID(),
      team_id: teamId,
      name: input.name,
      device: input.device ?? 'desktop',
      locale: input.locale ?? 'fr-FR',
      timezone_id: input.timezoneId ?? 'Europe/Paris',
      headless_default: input.headlessDefault ? 1 : 0,
      proxy_id: input.proxyId ?? null,
      state_version: 0,
      state_updated_at: null,
      created_by: createdBy,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO profiles (id, team_id, name, device, locale, timezone_id, headless_default, proxy_id, state_version, state_updated_at, created_by, created_at, updated_at)
         VALUES (@id, @team_id, @name, @device, @locale, @timezone_id, @headless_default, @proxy_id, @state_version, @state_updated_at, @created_by, @created_at, @updated_at)`
      )
      .run(row);
    return fromRow(row);
  }

  update(teamId: string, id: string, patch: Partial<CreateProfileInput>): ProfileRecord {
    const existing = this.get(teamId, id);
    if (!existing) {
      throw new Error(`ProfileRepository: profil inconnu dans cette team: ${id}`);
    }
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        `UPDATE profiles SET name = ?, device = ?, locale = ?, timezone_id = ?, headless_default = ?, proxy_id = ?, updated_at = ?
         WHERE team_id = ? AND id = ?`
      )
      .run(
        updated.name,
        updated.device,
        updated.locale,
        updated.timezoneId,
        updated.headlessDefault ? 1 : 0,
        updated.proxyId,
        updated.updatedAt,
        teamId,
        id
      );
    return updated;
  }

  remove(teamId: string, id: string): void {
    this.db.prepare('DELETE FROM profiles WHERE team_id = ? AND id = ?').run(teamId, id);
  }

  /** Incrémente `state_version` après un upload d'état réussi (cf. profileState.ts) — jamais décrémenté. */
  bumpStateVersion(teamId: string, id: string): ProfileRecord {
    const existing = this.get(teamId, id);
    if (!existing) {
      throw new Error(`ProfileRepository: profil inconnu dans cette team: ${id}`);
    }
    const now = new Date().toISOString();
    const nextVersion = existing.stateVersion + 1;
    this.db
      .prepare('UPDATE profiles SET state_version = ?, state_updated_at = ?, updated_at = ? WHERE team_id = ? AND id = ?')
      .run(nextVersion, now, now, teamId, id);
    return { ...existing, stateVersion: nextVersion, stateUpdatedAt: now, updatedAt: now };
  }
}
