import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

/**
 * Ouvre (et initialise si besoin) la base SQLite du backend cloud smonster — un seul process Node
 * en est propriétaire (le serveur sur le VPS), jamais un client Electron directement, cf. plan
 * d'archi. `better-sqlite3` est synchrone, comme le reste du style de ce projet (`ProfileStore`
 * utilise déjà `fs.*Sync` pour la même raison : Node mono-thread, pas de concurrence intra-process
 * à sérialiser manuellement).
 *
 * Schéma appliqué via `schema.sql`, chaque `CREATE TABLE`/`CREATE INDEX` en `IF NOT EXISTS` —
 * jamais de migration destructive automatique ici.
 */
/** `ALTER TABLE ... ADD COLUMN`, idempotent — seul moyen d'ajouter une colonne à une table déjà
 * existante en SQLite (contrairement à CREATE TABLE/INDEX, pas de `IF NOT EXISTS` ici). */
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function openDatabase(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // lectures concurrentes pendant une écriture, utile dès 2+ requêtes simultanées
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // 2FA (ajouté après le lancement initial) : colonnes additives sur `users`, cf. doc dans schema.sql.
  ensureColumn(db, 'users', 'totp_secret_enc', 'totp_secret_enc TEXT');
  ensureColumn(db, 'users', 'totp_enabled_at', 'totp_enabled_at TEXT');
  ensureColumn(db, 'users', 'totp_last_step', 'totp_last_step INTEGER');
  ensureColumn(db, 'users', 'email_otp_enabled', 'email_otp_enabled INTEGER NOT NULL DEFAULT 0');

  return db;
}
