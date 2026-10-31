import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PresenceTracker } from './presence';

function entry(overrides: Partial<Parameters<PresenceTracker['acquire']>[1]> = {}) {
  return {
    teamId: 'team-1',
    userId: 'user-1',
    socketId: 'socket-1',
    machineLabel: 'machine-A',
    acquiredAt: new Date().toISOString(),
    ...overrides,
  };
}

test('acquire(): réussit si libre, échoue si déjà tenu par un AUTRE socket', () => {
  const presence = new PresenceTracker();
  assert.equal(presence.acquire('profile-1', entry()), true);
  assert.equal(presence.acquire('profile-1', entry({ socketId: 'socket-2', userId: 'user-2' })), false);
  // Le même socket qui ré-acquiert son propre verrou (ex. reconnexion rapide) doit réussir.
  assert.equal(presence.acquire('profile-1', entry()), true);
});

test('release(): no-op si le socket appelant ne tient pas CE verrou (jamais d\'exception)', () => {
  const presence = new PresenceTracker();
  presence.acquire('profile-1', entry({ socketId: 'socket-1' }));
  presence.release('profile-1', 'socket-2'); // un autre socket essaie de libérer -> ignoré
  assert.ok(presence.get('profile-1'), 'le verrou doit rester tenu par socket-1');
  presence.release('profile-1', 'socket-1');
  assert.equal(presence.get('profile-1'), undefined);
});

test('releaseAllForSocket(): libère tous les profils tenus par ce socket, avec teamId pour le broadcast', () => {
  const presence = new PresenceTracker();
  presence.acquire('profile-1', entry({ socketId: 'socket-1', teamId: 'team-1' }));
  presence.acquire('profile-2', entry({ socketId: 'socket-1', teamId: 'team-2' }));
  presence.acquire('profile-3', entry({ socketId: 'socket-OTHER' })); // ne doit pas être touché

  const released = presence.releaseAllForSocket('socket-1');
  assert.equal(released.length, 2);
  const byProfile = Object.fromEntries(released.map((r) => [r.profileId, r.entry.teamId]));
  assert.equal(byProfile['profile-1'], 'team-1');
  assert.equal(byProfile['profile-2'], 'team-2');

  assert.equal(presence.get('profile-1'), undefined);
  assert.equal(presence.get('profile-2'), undefined);
  assert.ok(presence.get('profile-3'), 'un verrou tenu par un AUTRE socket ne doit pas être libéré');

  // Appeler une deuxième fois (ex. double event disconnect) ne doit rien casser.
  assert.deepEqual(presence.releaseAllForSocket('socket-1'), []);
});

test('forceRelease(): libère peu importe qui tenait le verrou', () => {
  const presence = new PresenceTracker();
  presence.acquire('profile-1', entry({ socketId: 'socket-1' }));
  presence.forceRelease('profile-1');
  assert.equal(presence.get('profile-1'), undefined);
  // No-op sûr si déjà libre.
  presence.forceRelease('profile-1');
});

test('snapshotForTeam(): ne retourne que les profils demandés qui sont EFFECTIVEMENT en cours d\'usage', () => {
  const presence = new PresenceTracker();
  presence.acquire('profile-1', entry());
  const snapshot = presence.snapshotForTeam(['profile-1', 'profile-2']);
  assert.ok(snapshot['profile-1']);
  assert.equal(snapshot['profile-2'], undefined);
});
