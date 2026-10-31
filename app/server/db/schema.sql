-- Schéma du backend cloud smonster (teams/membres/catalogue partagé). Exécuté une fois au
-- démarrage du serveur (cf. db/index.ts), idempotent via IF NOT EXISTS — jamais de migration
-- destructive automatique ici.
--
-- `SUPER_ADMIN` est un flag sur `users` (orthogonal aux teams, pas besoin d'appartenir à une
-- équipe) ; `TEAM_ADMIN`/`MEMBER` sont des rôles scoped à une team via `memberships.role`.
-- `TEAM_ADMIN` a toujours tous les droits sur SA team (non restreignable). Un `MEMBER` peut
-- toujours lire le catalogue et lancer/arrêter un profil (non gated) ; `member_permissions`
-- ajoute des droits d'édition au cas par cas, accordés/retirés individuellement par le
-- `TEAM_ADMIN` (cf. driverBuilder du projet pour le même esprit "pas de rôle figé" appliqué ici
-- aux permissions plutôt qu'au fingerprint).

-- Colonnes 2FA (totp_secret_enc/totp_enabled_at/totp_last_step/email_otp_enabled) ajoutées après
-- coup via une migration additive dans db/index.ts (`ALTER TABLE ... ADD COLUMN`, pas ici) — SQLite
-- ne supporte `IF NOT EXISTS` que sur CREATE TABLE/INDEX, jamais pour ajouter une colonne à une
-- table déjà existante.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_super_admin INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  seat_limit INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  role TEXT NOT NULL CHECK(role IN ('TEAM_ADMIN','MEMBER')),
  created_at TEXT NOT NULL,
  UNIQUE(user_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_team ON memberships(team_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);

-- Permissions granulaires PAR MEMBRE (pas par rôle) : vide par défaut pour un nouveau MEMBER.
CREATE TABLE IF NOT EXISTS member_permissions (
  membership_id TEXT NOT NULL REFERENCES memberships(id),
  permission TEXT NOT NULL CHECK(permission IN (
    'profiles:create', 'profiles:edit', 'profiles:delete',
    'proxies:create', 'proxies:edit', 'proxies:delete'
  )),
  granted_by TEXT NOT NULL REFERENCES users(id),
  granted_at TEXT NOT NULL,
  PRIMARY KEY (membership_id, permission)
);

CREATE TABLE IF NOT EXISTS proxies (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  label TEXT NOT NULL,
  server TEXT NOT NULL,
  username TEXT,
  password_encrypted TEXT,
  bypass TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proxies_team ON proxies(team_id);

-- Config partagée ; l'état réel (cookies/sessions) est stocké à part, cf. profile-state sur
-- disque (app/server/profileState.ts) — jamais dans cette table ni dans le fichier .sqlite.
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL,
  device TEXT NOT NULL,
  locale TEXT NOT NULL,
  timezone_id TEXT NOT NULL,
  headless_default INTEGER NOT NULL DEFAULT 0,
  proxy_id TEXT REFERENCES proxies(id),
  state_version INTEGER NOT NULL DEFAULT 0,
  state_updated_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_team ON profiles(team_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL,
  device_label TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('TEAM_ADMIN','MEMBER')),
  token_hash TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_invites_team ON invites(team_id);

-- Codes à usage unique pour la 2FA par email (login seulement — pas de changement d'email/
-- signup dans ce projet, invitation uniquement). Le code lui-même n'est jamais stocké en clair,
-- seul son hash (cf. app/server/auth/emailCodes.ts).
CREATE TABLE IF NOT EXISTS email_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_codes_user ON email_codes(user_id);

-- Audit trail seulement — PAS le verrou live (ça, c'est en mémoire, cf. app/server/ws/presence.ts).
CREATE TABLE IF NOT EXISTS profile_usage_log (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  machine_label TEXT,
  action TEXT NOT NULL CHECK(action IN ('acquired', 'released', 'force_released')),
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_log_profile ON profile_usage_log(profile_id);
