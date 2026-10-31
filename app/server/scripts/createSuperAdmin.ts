/**
 * Script one-off pour créer le tout premier compte `SUPER_ADMIN` — pas d'auto-inscription
 * possible pour ce rôle (cohérent avec un rôle de propriétaire de plateforme, cf. plan).
 * Tous les autres comptes se créent via le flux d'invitation (`POST /api/auth/accept-invite`).
 *
 * Usage : node dist/server/scripts/createSuperAdmin.js <email> <password> <displayName>
 */
import * as path from 'path';
import { openDatabase } from '../db';
import { UserRepository } from '../db/users';
import { hashPassword } from '../auth/passwords';

async function main() {
  const [email, password, displayName] = process.argv.slice(2);
  if (!email || !password || !displayName) {
    console.error('Usage: createSuperAdmin.js <email> <password> <displayName>');
    process.exit(1);
  }

  const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '..', '..', '..', 'data');
  const db = openDatabase(path.join(DATA_DIR, 'smonster.sqlite'));
  const users = new UserRepository(db);

  if (users.findByEmail(email.toLowerCase())) {
    console.error(`Un compte existe déjà pour ${email}.`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const user = users.create({ email: email.toLowerCase(), passwordHash, displayName, isSuperAdmin: true });
  console.log(`SUPER_ADMIN créé : ${user.email} (id: ${user.id})`);
}

main().catch((err) => {
  console.error('Échec de création du SUPER_ADMIN :', err);
  process.exit(1);
});
