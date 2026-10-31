import type { Database } from 'better-sqlite3';
import { randomUUID, randomBytes, createHash } from 'crypto';
import type { MembershipRole } from '../auth/jwt';

export interface TeamRecord {
  id: string;
  name: string;
  seatLimit: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface MembershipRecord {
  id: string;
  userId: string;
  teamId: string;
  role: MembershipRole;
  createdAt: string;
}

export interface MemberView {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string;
  role: MembershipRole;
  permissions: string[];
}

export interface InviteRecord {
  id: string;
  teamId: string;
  email: string;
  role: MembershipRole;
  tokenHash: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

/**
 * Teams + memberships + permissions granulaires + invites : regroupés dans un seul repository,
 * pas un fichier par table — ces quatre tables ne prennent jamais sens l'une sans les autres
 * (une permission n'existe que sur une membership, une membership que sur une team), les séparer
 * aurait juste éclaté des opérations qui touchent plusieurs d'entre elles à chaque fois (ex.
 * `createTeam` crée la team ET la membership TEAM_ADMIN du créateur dans la même transaction).
 */
export class TeamRepository {
  constructor(private readonly db: Database) {}

  createTeam(name: string, createdByUserId: string): TeamRecord {
    const now = new Date().toISOString();
    const team: TeamRecord = { id: randomUUID(), name, seatLimit: null, createdAt: now, updatedAt: now };
    const createTx = this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO teams (id, name, seat_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(team.id, team.name, team.seatLimit, team.createdAt, team.updatedAt);
      this.addMembership(team.id, createdByUserId, 'TEAM_ADMIN');
    });
    createTx();
    return team;
  }

  getTeam(teamId: string): TeamRecord | undefined {
    const row = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as
      | { id: string; name: string; seat_limit: number | null; created_at: string; updated_at: string }
      | undefined;
    if (!row) return undefined;
    return { id: row.id, name: row.name, seatLimit: row.seat_limit, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  /** Teams auxquelles un utilisateur appartient, avec son rôle dans chacune. */
  listTeamsForUser(userId: string): { team: TeamRecord; role: MembershipRole }[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.name, t.seat_limit, t.created_at, t.updated_at, m.role
         FROM teams t JOIN memberships m ON m.team_id = t.id
         WHERE m.user_id = ?`
      )
      .all(userId) as { id: string; name: string; seat_limit: number | null; created_at: string; updated_at: string; role: MembershipRole }[];
    return rows.map((r) => ({
      team: { id: r.id, name: r.name, seatLimit: r.seat_limit, createdAt: r.created_at, updatedAt: r.updated_at },
      role: r.role,
    }));
  }

  renameTeam(teamId: string, name: string): TeamRecord {
    this.db.prepare('UPDATE teams SET name = ?, updated_at = ? WHERE id = ?').run(name, new Date().toISOString(), teamId);
    return this.getTeam(teamId)!;
  }

  /**
   * Cascade manuelle (pas de `ON DELETE CASCADE` dans schema.sql, volontairement - une suppression
   * en cascade implicite est facile à déclencher par erreur ; ici c'est une seule méthode, explicite,
   * appelée uniquement depuis la route "zone de danger"). Ordre contraint par les FKs : les profils
   * référencent `proxies(id)`, donc ils doivent être supprimés avant les proxys, pas après.
   * Les fichiers d'état des profils (hors DB) sont nettoyés par l'appelant, cf. teamsRouter.ts.
   */
  deleteTeam(teamId: string): void {
    const deleteTx = this.db.transaction(() => {
      const membershipIds = (this.db.prepare('SELECT id FROM memberships WHERE team_id = ?').all(teamId) as { id: string }[]).map((r) => r.id);
      for (const membershipId of membershipIds) {
        this.db.prepare('DELETE FROM member_permissions WHERE membership_id = ?').run(membershipId);
      }
      this.db.prepare('DELETE FROM memberships WHERE team_id = ?').run(teamId);
      this.db.prepare('DELETE FROM invites WHERE team_id = ?').run(teamId);

      const profileIds = (this.db.prepare('SELECT id FROM profiles WHERE team_id = ?').all(teamId) as { id: string }[]).map((r) => r.id);
      for (const profileId of profileIds) {
        this.db.prepare('DELETE FROM profile_usage_log WHERE profile_id = ?').run(profileId);
      }
      this.db.prepare('DELETE FROM profiles WHERE team_id = ?').run(teamId);
      this.db.prepare('DELETE FROM proxies WHERE team_id = ?').run(teamId);
      this.db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
    });
    deleteTx();
  }

  getMembership(userId: string, teamId: string): MembershipRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM memberships WHERE user_id = ? AND team_id = ?')
      .get(userId, teamId) as { id: string; user_id: string; team_id: string; role: MembershipRole; created_at: string } | undefined;
    if (!row) return undefined;
    return { id: row.id, userId: row.user_id, teamId: row.team_id, role: row.role, createdAt: row.created_at };
  }

  addMembership(teamId: string, userId: string, role: MembershipRole): MembershipRecord {
    const record: MembershipRecord = { id: randomUUID(), userId, teamId, role, createdAt: new Date().toISOString() };
    this.db
      .prepare('INSERT INTO memberships (id, user_id, team_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(record.id, record.userId, record.teamId, record.role, record.createdAt);
    return record;
  }

  removeMembership(membershipId: string): void {
    const removeTx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM member_permissions WHERE membership_id = ?').run(membershipId);
      this.db.prepare('DELETE FROM memberships WHERE id = ?').run(membershipId);
    });
    removeTx();
  }

  updateMembershipRole(membershipId: string, role: MembershipRole): void {
    this.db.prepare('UPDATE memberships SET role = ? WHERE id = ?').run(role, membershipId);
  }

  listMembers(teamId: string): MemberView[] {
    const rows = this.db
      .prepare(
        `SELECT m.id as membership_id, u.id as user_id, u.email, u.display_name, m.role
         FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.team_id = ?`
      )
      .all(teamId) as { membership_id: string; user_id: string; email: string; display_name: string; role: MembershipRole }[];
    return rows.map((r) => ({
      membershipId: r.membership_id,
      userId: r.user_id,
      email: r.email,
      displayName: r.display_name,
      role: r.role,
      permissions: this.getPermissions(r.membership_id),
    }));
  }

  getPermissions(membershipId: string): string[] {
    const rows = this.db
      .prepare('SELECT permission FROM member_permissions WHERE membership_id = ?')
      .all(membershipId) as { permission: string }[];
    return rows.map((r) => r.permission);
  }

  grantPermission(membershipId: string, permission: string, grantedBy: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO member_permissions (membership_id, permission, granted_by, granted_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(membershipId, permission, grantedBy, new Date().toISOString());
  }

  revokePermission(membershipId: string, permission: string): void {
    this.db.prepare('DELETE FROM member_permissions WHERE membership_id = ? AND permission = ?').run(membershipId, permission);
  }

  createInvite(teamId: string, email: string, role: MembershipRole, invitedBy: string): { invite: InviteRecord; token: string } {
    const token = randomBytes(24).toString('hex');
    const now = new Date();
    const invite: InviteRecord = {
      id: randomUUID(),
      teamId,
      email,
      role,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      invitedBy,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
      acceptedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO invites (id, team_id, email, role, token_hash, invited_by, created_at, expires_at, accepted_at)
         VALUES (@id, @teamId, @email, @role, @tokenHash, @invitedBy, @createdAt, @expiresAt, @acceptedAt)`
      )
      .run(invite);
    return { invite, token };
  }

  /** `undefined` si le token est inconnu, expiré, ou déjà utilisé — jamais d'exception. */
  findValidInviteByToken(token: string): InviteRecord | undefined {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const row = this.db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(tokenHash) as
      | { id: string; team_id: string; email: string; role: MembershipRole; token_hash: string; invited_by: string; created_at: string; expires_at: string; accepted_at: string | null }
      | undefined;
    if (!row || row.accepted_at || new Date(row.expires_at).getTime() < Date.now()) return undefined;
    return {
      id: row.id,
      teamId: row.team_id,
      email: row.email,
      role: row.role,
      tokenHash: row.token_hash,
      invitedBy: row.invited_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
    };
  }

  markInviteAccepted(inviteId: string): void {
    this.db.prepare('UPDATE invites SET accepted_at = ? WHERE id = ?').run(new Date().toISOString(), inviteId);
  }
}
