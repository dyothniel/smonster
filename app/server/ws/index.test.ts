import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { io as ioClient } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { openDatabase } from '../db';
import { UserRepository } from '../db/users';
import { TeamRepository } from '../db/teams';
import { hashPassword } from '../auth/passwords';
import { signAccessToken } from '../auth/jwt';
import { PresenceTracker } from './presence';
import { attachWebSocket } from './index';

/**
 * Serveur Socket.IO réel sur un port local jetable + deux vrais clients `socket.io-client` —
 * même esprit que le test Service Worker de driverBuilder.test.ts (un vrai serveur HTTP local
 * plutôt qu'un mock), parce que c'est justement le comportement réseau (heartbeat, disconnect)
 * qu'on veut vérifier, pas juste la logique pure de `PresenceTracker` (déjà couverte à part dans
 * presence.test.ts).
 */
async function startTestServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smonster-wstest-'));
  const db = openDatabase(path.join(dataDir, 'test.sqlite'));
  const users = new UserRepository(db);
  const teams = new TeamRepository(db);
  const presence = new PresenceTracker();

  const passwordHash = await hashPassword('x');
  const userA = users.create({ email: 'a@example.com', passwordHash, displayName: 'A' });
  const userB = users.create({ email: 'b@example.com', passwordHash, displayName: 'B' });
  const team = teams.createTeam('Équipe WS', userA.id);
  teams.addMembership(team.id, userB.id, 'MEMBER');

  const tokenA = signAccessToken({ sub: userA.id, email: userA.email, displayName: userA.displayName, isSuperAdmin: false, teams: [{ teamId: team.id, role: 'TEAM_ADMIN' }] });
  const tokenB = signAccessToken({ sub: userB.id, email: userB.email, displayName: userB.displayName, isSuperAdmin: false, teams: [{ teamId: team.id, role: 'MEMBER' }] });

  const httpServer = http.createServer();
  // Heartbeat raccourci : un `socket.disconnect()` propre côté client est détecté quasi
  // immédiatement par le serveur de toute façon (pas besoin d'attendre le ping timeout pour CE
  // cas), mais des valeurs courtes gardent la suite rapide même si ce n'était pas le cas.
  const io = attachWebSocket(httpServer, presence, { pingInterval: 300, pingTimeout: 300 });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('adresse inattendue');
  const url = `http://127.0.0.1:${address.port}`;

  async function close(...sockets: ClientSocket[]) {
    for (const s of sockets) s.disconnect();
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { url, teamId: team.id, tokenA, tokenB, close };
}

function connect(url: string, token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { auth: { token }, reconnection: false, transports: ['websocket'] });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function once(socket: ClientSocket, event: string): Promise<any> {
  return new Promise((resolve) => socket.once(event, resolve));
}

test('connexion WS refusée sans token valide', async () => {
  const { url, close } = await startTestServer();
  try {
    await assert.rejects(
      () =>
        new Promise((_resolve, reject) => {
          const socket = ioClient(url, { auth: { token: 'token-invalide' }, reconnection: false, transports: ['websocket'] });
          socket.once('connect_error', reject);
        })
    );
  } finally {
    await close();
  }
});

test('profile:acquire — le deuxième membre est refusé tant que le premier tient le verrou, et voit le broadcast presence:acquired', async () => {
  const { url, teamId, tokenA, tokenB, close } = await startTestServer();
  const socketA = await connect(url, tokenA);
  const socketB = await connect(url, tokenB);
  try {
    const broadcastPromise = once(socketB, 'presence:acquired');

    const ackA = await new Promise<{ ok: boolean }>((resolve) => socketA.emit('profile:acquire', { teamId, profileId: 'profile-1', machineLabel: 'PC-A' }, resolve));
    assert.equal(ackA.ok, true);

    const broadcast = await broadcastPromise;
    assert.equal(broadcast.profileId, 'profile-1');

    const ackB = await new Promise<{ ok: boolean; error?: string }>((resolve) => socketB.emit('profile:acquire', { teamId, profileId: 'profile-1' }, resolve));
    assert.equal(ackB.ok, false);
    assert.equal(ackB.error, 'already_in_use');
  } finally {
    await close(socketA, socketB);
  }
});

test('déconnexion du socket qui tient le verrou -> libération automatique sous le délai du heartbeat, annoncée à l\'autre membre', async () => {
  const { url, teamId, tokenA, tokenB, close } = await startTestServer();
  const socketA = await connect(url, tokenA);
  const socketB = await connect(url, tokenB);
  try {
    await new Promise<{ ok: boolean }>((resolve) => socketA.emit('profile:acquire', { teamId, profileId: 'profile-1' }, resolve));

    const releasedPromise = once(socketB, 'presence:released');
    socketA.disconnect(); // simule un crash/déconnexion brutale, pas un `profile:release` propre

    const released = await releasedPromise;
    assert.equal(released.profileId, 'profile-1');
    assert.equal(released.forced, false);
  } finally {
    await close(socketB);
  }
});

test('profile:forceRelease — refusé pour un MEMBER, autorisé pour un TEAM_ADMIN', async () => {
  const { url, teamId, tokenA, tokenB, close } = await startTestServer();
  const socketA = await connect(url, tokenA); // TEAM_ADMIN
  const socketB = await connect(url, tokenB); // MEMBER
  try {
    await new Promise<{ ok: boolean }>((resolve) => socketB.emit('profile:acquire', { teamId, profileId: 'profile-1' }, resolve));

    const deniedByMember = await new Promise<{ ok: boolean; error?: string }>((resolve) =>
      socketB.emit('profile:forceRelease', { teamId, profileId: 'profile-1' }, resolve)
    );
    assert.equal(deniedByMember.ok, false);
    assert.equal(deniedByMember.error, 'forbidden');

    const allowedByAdmin = await new Promise<{ ok: boolean }>((resolve) =>
      socketA.emit('profile:forceRelease', { teamId, profileId: 'profile-1' }, resolve)
    );
    assert.equal(allowedByAdmin.ok, true);
  } finally {
    await close(socketA, socketB);
  }
});
