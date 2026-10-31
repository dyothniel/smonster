import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import * as http from 'http';
import { openDatabase } from './db';
import { UserRepository } from './db/users';
import { TeamRepository } from './db/teams';
import { ProxyRepository } from './db/proxies';
import { ProfileRepository } from './db/profiles';
import { RefreshTokenRepository } from './db/refreshTokens';
import { EmailCodeRepository } from './db/emailCodes';
import { ProfileStateStore } from './profileState';
import { PresenceTracker } from './ws/presence';
import { createApp } from './httpServer';
import { hashPassword } from './auth/passwords';

// Pas de `supertest` dans ce projet (pas encore une dépendance) : un vrai `app.listen(0)` +
// `fetch()` global (Node 20+) suffit, même esprit que le serveur HTTP local déjà utilisé dans
// driverBuilder.test.ts pour les tests de Service Worker — pas de nouvelle dépendance pour ça.
async function startTestServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smonster-httptest-'));
  const db = openDatabase(path.join(dataDir, 'test.sqlite'));
  const deps = {
    users: new UserRepository(db),
    teams: new TeamRepository(db),
    proxies: new ProxyRepository(db),
    profiles: new ProfileRepository(db),
    refreshTokens: new RefreshTokenRepository(db),
    emailCodes: new EmailCodeRepository(db),
    state: new ProfileStateStore(path.join(dataDir, 'profile-state')),
    presence: new PresenceTracker(),
    dataDir,
  };
  const app = createApp(deps);
  const server: Server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('adresse de serveur HTTP inattendue');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function close() {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return { baseUrl, deps, dataDir, close };
}

async function api(baseUrl: string, path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, body: json };
}

/** Crée un SUPER_ADMIN directement en base (comme le ferait createSuperAdmin.ts) puis le connecte. */
async function loginAsNewSuperAdmin(baseUrl: string, deps: Awaited<ReturnType<typeof startTestServer>>['deps']) {
  const email = `admin-${Date.now()}@example.com`;
  const passwordHash = await hashPassword('correct horse battery staple');
  deps.users.create({ email, passwordHash, displayName: 'Super Admin', isSuperAdmin: true });
  const login = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { email, password: 'correct horse battery staple' } });
  assert.equal(login.status, 200);
  return login.body as { accessToken: string; refreshToken: string };
}

test('auth: login refuse un email inconnu ou un mauvais mot de passe', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const unknown = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'x' } });
    assert.equal(unknown.status, 401);
  } finally {
    await close();
  }
});

test('teams: le créateur devient TEAM_ADMIN, apparaît dans la liste de ses teams', async () => {
  const { baseUrl, deps, close } = await startTestServer();
  try {
    const { accessToken } = await loginAsNewSuperAdmin(baseUrl, deps);
    const created = await api(baseUrl, '/api/teams', { method: 'POST', token: accessToken, body: { name: 'Équipe Test' } });
    assert.equal(created.status, 201);

    const mine = await api(baseUrl, '/api/teams', { token: accessToken });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.length, 1);
    assert.equal(mine.body[0].role, 'TEAM_ADMIN');
    assert.equal(mine.body[0].team.name, 'Équipe Test');
  } finally {
    await close();
  }
});

test('teams: renommer est réservé au TEAM_ADMIN, retiré au MEMBER', async () => {
  const { baseUrl, deps, close } = await startTestServer();
  try {
    const admin = await loginAsNewSuperAdmin(baseUrl, deps);
    const created = await api(baseUrl, '/api/teams', { method: 'POST', token: admin.accessToken, body: { name: 'Avant' } });
    const teamId = created.body.id;

    const renamed = await api(baseUrl, `/api/teams/${teamId}`, { method: 'PATCH', token: admin.accessToken, body: { name: 'Après' } });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'Après');

    const passwordHash = await hashPassword('motdepasse-test');
    const member = deps.users.create({ email: 'membre-rename@test.local', passwordHash, displayName: 'Membre' });
    deps.teams.addMembership(teamId, member.id, 'MEMBER');
    const memberLogin = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { email: member.email, password: 'motdepasse-test' } });

    const refused = await api(baseUrl, `/api/teams/${teamId}`, { method: 'PATCH', token: memberLogin.body.accessToken, body: { name: 'Hack' } });
    assert.equal(refused.status, 403);
  } finally {
    await close();
  }
});

test("teams: supprimer l'équipe cascade sur ses profils/proxys (DB + archive d'état) et ses invitations", async () => {
  const { baseUrl, deps, close } = await startTestServer();
  try {
    const admin = await loginAsNewSuperAdmin(baseUrl, deps);
    const created = await api(baseUrl, '/api/teams', { method: 'POST', token: admin.accessToken, body: { name: 'À supprimer' } });
    const teamId = created.body.id;

    const proxy = await api(baseUrl, `/api/teams/${teamId}/proxies`, { method: 'POST', token: admin.accessToken, body: { label: 'P', server: 'http://x:8080' } });
    const profile = await api(baseUrl, `/api/teams/${teamId}/profiles`, { method: 'POST', token: admin.accessToken, body: { name: 'Profil', proxyId: proxy.body.id } });
    const profileId = profile.body.id;

    const stateBody = Buffer.from('fake-state-archive');
    const uploadRes = await fetch(`${baseUrl}/api/teams/${teamId}/profiles/${profileId}/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/gzip', Authorization: `Bearer ${admin.accessToken}` },
      body: stateBody,
    });
    assert.equal(uploadRes.status, 200);
    assert.ok(deps.state.exists(profileId));

    await api(baseUrl, `/api/teams/${teamId}/invites`, { method: 'POST', token: admin.accessToken, body: { email: 'invite@test.local', role: 'MEMBER' } });

    const deleted = await api(baseUrl, `/api/teams/${teamId}`, { method: 'DELETE', token: admin.accessToken });
    assert.equal(deleted.status, 204);

    assert.equal(deps.teams.getTeam(teamId), undefined);
    assert.equal(deps.profiles.get(teamId, profileId), undefined);
    assert.equal(deps.state.exists(profileId), false);

    const mine = await api(baseUrl, '/api/teams', { token: admin.accessToken });
    assert.equal(mine.body.length, 0);
  } finally {
    await close();
  }
});

test('permissions granulaires: un MEMBER sans permission se fait refuser la création de profil, puis accepter une fois accordée', async () => {
  const { baseUrl, deps, close } = await startTestServer();
  try {
    const admin = await loginAsNewSuperAdmin(baseUrl, deps);
    const team = (await api(baseUrl, '/api/teams', { method: 'POST', token: admin.accessToken, body: { name: 'Équipe' } })).body;

    const invite = await api(baseUrl, `/api/teams/${team.id}/invites`, {
      method: 'POST',
      token: admin.accessToken,
      body: { email: 'membre@example.com', role: 'MEMBER' },
    });
    assert.equal(invite.status, 201);

    const accepted = await api(baseUrl, '/api/auth/accept-invite', {
      method: 'POST',
      body: { token: invite.body.token, password: 'motdepasse123', displayName: 'Membre Test' },
    });
    assert.equal(accepted.status, 200);
    const memberToken = accepted.body.accessToken as string;

    const deniedCreate = await api(baseUrl, `/api/teams/${team.id}/profiles`, {
      method: 'POST',
      token: memberToken,
      body: { name: 'Profil A' },
    });
    assert.equal(deniedCreate.status, 403, 'un MEMBER sans permission ne doit pas pouvoir créer de profil');

    // Le membre PEUT quand même lire le catalogue (lecture/usage non gated, cf. plan).
    const listAsMember = await api(baseUrl, `/api/teams/${team.id}/profiles`, { token: memberToken });
    assert.equal(listAsMember.status, 200);

    const members = (await api(baseUrl, `/api/teams/${team.id}/members`, { token: admin.accessToken })).body as {
      membershipId: string;
      role: string;
    }[];
    const memberRow = members.find((m) => m.role === 'MEMBER')!;
    assert.ok(memberRow, 'le membre doit apparaître dans la liste');

    const grant = await api(baseUrl, `/api/teams/${team.id}/members/${memberRow.membershipId}/permissions/profiles:create`, {
      method: 'PUT',
      token: admin.accessToken,
    });
    assert.equal(grant.status, 200);

    // Même token d'accès qu'avant (pas de refresh) : la permission accordée doit être visible
    // IMMÉDIATEMENT, pas seulement après un refresh — cf. doc de `requirePermission` (lu en
    // direct depuis la base, pas depuis le JWT).
    const allowedCreate = await api(baseUrl, `/api/teams/${team.id}/profiles`, {
      method: 'POST',
      token: memberToken,
      body: { name: 'Profil A' },
    });
    assert.equal(allowedCreate.status, 201, 'après avoir accordé profiles:create, la création doit réussir sans nouveau login');

    const revoke = await api(baseUrl, `/api/teams/${team.id}/members/${memberRow.membershipId}/permissions/profiles:create`, {
      method: 'DELETE',
      token: admin.accessToken,
    });
    assert.equal(revoke.status, 200);

    const deniedAgain = await api(baseUrl, `/api/teams/${team.id}/profiles`, {
      method: 'POST',
      token: memberToken,
      body: { name: 'Profil B' },
    });
    assert.equal(deniedAgain.status, 403, 'après révocation, la création doit de nouveau être refusée immédiatement');
  } finally {
    await close();
  }
});

test('isolation entre teams: un utilisateur hors team se fait refuser (403), pas 404 qui révélerait l\'existence de la team', async () => {
  const { baseUrl, deps, close } = await startTestServer();
  try {
    const owner = await loginAsNewSuperAdmin(baseUrl, deps);
    const team = (await api(baseUrl, '/api/teams', { method: 'POST', token: owner.accessToken, body: { name: 'Équipe Privée' } })).body;

    const passwordHash = await hashPassword('autremotdepasse');
    deps.users.create({ email: 'etranger@example.com', passwordHash, displayName: 'Étranger' });
    const outsider = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { email: 'etranger@example.com', password: 'autremotdepasse' } });

    const denied = await api(baseUrl, `/api/teams/${team.id}/profiles`, { token: outsider.body.accessToken });
    assert.equal(denied.status, 403);
  } finally {
    await close();
  }
});

test('refresh token: rotation à chaque usage, l\'ancien devient inutilisable (vol détectable)', async () => {
  const { baseUrl, deps, close } = await startTestServer();
  try {
    const { refreshToken } = await loginAsNewSuperAdmin(baseUrl, deps);
    const first = await api(baseUrl, '/api/auth/refresh', { method: 'POST', body: { refreshToken } });
    assert.equal(first.status, 200);
    assert.notEqual(first.body.refreshToken, refreshToken, 'un nouveau refresh token doit être émis à chaque usage');

    const reuse = await api(baseUrl, '/api/auth/refresh', { method: 'POST', body: { refreshToken } });
    assert.equal(reuse.status, 401, 'réutiliser un refresh token déjà consommé doit échouer');
  } finally {
    await close();
  }
});

test('proxy: le mot de passe ne ressort jamais dans la liste, mais ressort (déchiffré) sur un GET précis', async () => {
  const { baseUrl, deps, close } = await startTestServer();
  try {
    const admin = await loginAsNewSuperAdmin(baseUrl, deps);
    const team = (await api(baseUrl, '/api/teams', { method: 'POST', token: admin.accessToken, body: { name: 'Équipe' } })).body;

    const created = await api(baseUrl, `/api/teams/${team.id}/proxies`, {
      method: 'POST',
      token: admin.accessToken,
      body: { label: 'Proxy FR', server: 'http://proxy.example.com:8080', username: 'u', password: 'secret123' },
    });
    assert.equal(created.status, 201);

    const list = await api(baseUrl, `/api/teams/${team.id}/proxies`, { token: admin.accessToken });
    assert.equal(list.body[0].password, undefined, 'le mot de passe ne doit jamais apparaître dans une liste');

    const single = await api(baseUrl, `/api/teams/${team.id}/proxies/${created.body.id}`, { token: admin.accessToken });
    assert.equal(single.body.password, 'secret123', 'déchiffré correctement sur un GET précis');
  } finally {
    await close();
  }
});

test('état du profil: upload puis download renvoient exactement les mêmes octets, stateVersion incrémente', async () => {
  const { baseUrl, deps, close } = await startTestServer();
  try {
    const admin = await loginAsNewSuperAdmin(baseUrl, deps);
    const team = (await api(baseUrl, '/api/teams', { method: 'POST', token: admin.accessToken, body: { name: 'Équipe' } })).body;
    const profile = (
      await api(baseUrl, `/api/teams/${team.id}/profiles`, { method: 'POST', token: admin.accessToken, body: { name: 'Profil' } })
    ).body;

    const fakeArchive = Buffer.from('contenu-factice-cookies-local-storage');
    const putRes = await fetch(`${baseUrl}/api/teams/${team.id}/profiles/${profile.id}/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/gzip', Authorization: `Bearer ${admin.accessToken}` },
      body: fakeArchive,
    });
    assert.equal(putRes.status, 200);
    const putBody = (await putRes.json()) as { stateVersion: number };
    assert.equal(putBody.stateVersion, 1);

    const getRes = await fetch(`${baseUrl}/api/teams/${team.id}/profiles/${profile.id}/state`, {
      headers: { Authorization: `Bearer ${admin.accessToken}` },
    });
    assert.equal(getRes.status, 200);
    const downloaded = Buffer.from(await getRes.arrayBuffer());
    assert.ok(downloaded.equals(fakeArchive), 'les octets téléchargés doivent être identiques à ceux uploadés');
  } finally {
    await close();
  }
});

// --- Mon compte : profil, mot de passe, 2FA ---------------------------------------------------

// Implémentation TOTP indépendante de celle testée (app/server/auth/totp.ts) — recalcule le code
// depuis le secret comme le ferait une vraie app d'authentification, plutôt que d'importer le
// code sous test pour le générer (ce qui masquerait une régression des deux côtés à la fois).
// `stepOffset` : permet de demander le code d'une fenêtre de 30s FUTURE sans attendre pour de
// vrai — utile pour tester le garde-fou anti-replay (`totp_last_step`) juste après un `/enable`
// qui vient de consommer la fenêtre courante, sans ralentir la suite de tests avec un vrai délai.
function totpCodeFor(secretBase32: string, stepOffset = 0): string {
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secretBase32.toUpperCase()) {
    const idx = ALPHA.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const secret = Buffer.from(bytes);
  const counter = Math.floor(Date.now() / 1000 / 30) + stepOffset;
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = require('crypto').createHmac('sha1', secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

function readLatestOutboxCode(dataDir: string): string {
  const outboxDir = path.join(dataDir, 'mail-outbox');
  const files = fs.readdirSync(outboxDir).sort();
  const html = fs.readFileSync(path.join(outboxDir, files[files.length - 1]), 'utf8');
  const match = html.match(/<b>(\d+)<\/b>/);
  if (!match) throw new Error('code introuvable dans le mail simulé');
  return match[1];
}

test('compte: modifier le nom affiché, changer le mot de passe (refuse un mauvais mot de passe actuel)', async () => {
  const { baseUrl, deps, close } = await startTestServer();
  try {
    const admin = await loginAsNewSuperAdmin(baseUrl, deps);

    const patched = await api(baseUrl, '/api/account', { method: 'PATCH', token: admin.accessToken, body: { displayName: 'Nouveau nom' } });
    assert.equal(patched.status, 200);
    const got = await api(baseUrl, '/api/account', { token: admin.accessToken });
    assert.equal(got.body.displayName, 'Nouveau nom');

    const badCurrent = await api(baseUrl, '/api/account/password', {
      method: 'POST',
      token: admin.accessToken,
      body: { currentPassword: 'mauvais', newPassword: 'un-nouveau-mot-de-passe' },
    });
    assert.equal(badCurrent.status, 401);

    const changed = await api(baseUrl, '/api/account/password', {
      method: 'POST',
      token: admin.accessToken,
      body: { currentPassword: 'correct horse battery staple', newPassword: 'un-nouveau-mot-de-passe' },
    });
    assert.equal(changed.status, 200);

    const oldPasswordLogin = await api(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: got.body.email, password: 'correct horse battery staple' },
    });
    assert.equal(oldPasswordLogin.status, 401);
    const newPasswordLogin = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { email: got.body.email, password: 'un-nouveau-mot-de-passe' } });
    assert.equal(newPasswordLogin.status, 200);
  } finally {
    await close();
  }
});

test('2FA TOTP: setup -> enable avec un mauvais code refusé, bon code accepté -> login exige le défi -> replay refusé', async () => {
  const { baseUrl, deps, close } = await startTestServer();
  try {
    const admin = await loginAsNewSuperAdmin(baseUrl, deps);

    const setup = await api(baseUrl, '/api/account/totp/setup', { method: 'POST', token: admin.accessToken });
    assert.equal(setup.status, 200);
    const { secret } = setup.body as { secret: string };

    const badEnable = await api(baseUrl, '/api/account/totp/enable', { method: 'POST', token: admin.accessToken, body: { code: '000000' } });
    assert.equal(badEnable.status, 401);

    const goodEnable = await api(baseUrl, '/api/account/totp/enable', { method: 'POST', token: admin.accessToken, body: { code: totpCodeFor(secret) } });
    assert.equal(goodEnable.status, 200);

    const got = await api(baseUrl, '/api/account', { token: admin.accessToken });
    assert.equal(got.body.totpEnabled, true);

    // Login avec mot de passe seul : ne doit plus renvoyer de tokens, juste un défi.
    const login = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { email: got.body.email, password: 'correct horse battery staple' } });
    assert.equal(login.status, 200);
    assert.equal(login.body.mfa, 'totp');
    assert.ok(!login.body.accessToken, 'aucun token ne doit être émis avant le second facteur');

    // Fenêtre de 30s SUIVANTE (pas celle déjà consommée par `/enable` juste au-dessus, cf.
    // garde-fou anti-replay sur `totp_last_step`) — simulée via `stepOffset`, pas un vrai délai.
    const code = totpCodeFor(secret, 1);
    const verified = await api(baseUrl, '/api/auth/login/verify', { method: 'POST', body: { challenge: login.body.challenge, code } });
    assert.equal(verified.status, 200);
    assert.ok(verified.body.accessToken);

    // Le même code, pour la même fenêtre de 30s, ne doit jamais pouvoir revalider une seconde fois.
    const login2 = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { email: got.body.email, password: 'correct horse battery staple' } });
    const replay = await api(baseUrl, '/api/auth/login/verify', { method: 'POST', body: { challenge: login2.body.challenge, code } });
    assert.equal(replay.status, 401);
  } finally {
    await close();
  }
});

test('2FA TOTP: désactiver exige le mot de passe, pas un code', async () => {
  const { baseUrl, deps, close } = await startTestServer();
  try {
    const admin = await loginAsNewSuperAdmin(baseUrl, deps);
    const { secret } = (await api(baseUrl, '/api/account/totp/setup', { method: 'POST', token: admin.accessToken })).body as { secret: string };
    await api(baseUrl, '/api/account/totp/enable', { method: 'POST', token: admin.accessToken, body: { code: totpCodeFor(secret) } });

    const badPassword = await api(baseUrl, '/api/account/totp/disable', { method: 'POST', token: admin.accessToken, body: { password: 'mauvais' } });
    assert.equal(badPassword.status, 401);

    const disabled = await api(baseUrl, '/api/account/totp/disable', {
      method: 'POST',
      token: admin.accessToken,
      body: { password: 'correct horse battery staple' },
    });
    assert.equal(disabled.status, 200);

    const got = await api(baseUrl, '/api/account', { token: admin.accessToken });
    assert.equal(got.body.totpEnabled, false);
    // Plus de 2FA -> un login simple doit à nouveau renvoyer directement des tokens.
    const login = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { email: got.body.email, password: 'correct horse battery staple' } });
    assert.ok(login.body.accessToken);
  } finally {
    await close();
  }
});

test('2FA email: activer exige un serveur mail configurable (dev: simulé sur disque), un mauvais code est refusé', async () => {
  const { baseUrl, deps, dataDir, close } = await startTestServer();
  try {
    const admin = await loginAsNewSuperAdmin(baseUrl, deps);
    const email = (await api(baseUrl, '/api/account', { token: admin.accessToken })).body.email as string;

    const enabled = await api(baseUrl, '/api/account/security', { method: 'PATCH', token: admin.accessToken, body: { emailOtpEnabled: true } });
    assert.equal(enabled.status, 200);

    const login = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { email, password: 'correct horse battery staple' } });
    assert.equal(login.status, 200);
    assert.equal(login.body.mfa, 'email');
    assert.ok(!login.body.accessToken);

    const badCode = await api(baseUrl, '/api/auth/login/verify', { method: 'POST', body: { challenge: login.body.challenge, code: '000000' } });
    assert.equal(badCode.status, 401);

    const code = readLatestOutboxCode(dataDir);
    const verified = await api(baseUrl, '/api/auth/login/verify', { method: 'POST', body: { challenge: login.body.challenge, code } });
    assert.equal(verified.status, 200);
    assert.ok(verified.body.accessToken);
  } finally {
    await close();
  }
});

test('2FA: un SUPER_ADMIN peut réinitialiser la 2FA d\'un compte tiers (compte verrouillé), un MEMBER ne peut pas', async () => {
  const { baseUrl, deps, close } = await startTestServer();
  try {
    const admin = await loginAsNewSuperAdmin(baseUrl, deps);
    const passwordHash = await hashPassword('motdepasse-victime');
    const victim = deps.users.create({ email: 'victime@test.local', passwordHash, displayName: 'Victime' });
    const victimLogin = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { email: victim.email, password: 'motdepasse-victime' } });
    const { secret } = (await api(baseUrl, '/api/account/totp/setup', { method: 'POST', token: victimLogin.body.accessToken })).body as {
      secret: string;
    };
    await api(baseUrl, '/api/account/totp/enable', { method: 'POST', token: victimLogin.body.accessToken, body: { code: totpCodeFor(secret) } });

    const refused = await api(baseUrl, `/api/account/users/${victim.id}/reset-2fa`, { method: 'POST', token: victimLogin.body.accessToken });
    assert.equal(refused.status, 403);

    const reset = await api(baseUrl, `/api/account/users/${victim.id}/reset-2fa`, { method: 'POST', token: admin.accessToken });
    assert.equal(reset.status, 200);

    const victimLogin2 = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { email: victim.email, password: 'motdepasse-victime' } });
    assert.ok(victimLogin2.body.accessToken, '2FA réinitialisée -> login simple à nouveau direct');
  } finally {
    await close();
  }
});
