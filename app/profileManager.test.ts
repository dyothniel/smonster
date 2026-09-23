import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProfileStore } from './profileStore';
import { ProfileManager } from './profileManager';

const tempDataDirs: string[] = [];
function makeManager(): ProfileManager {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profilemanager-test-'));
  tempDataDirs.push(dir);
  return new ProfileManager(new ProfileStore(dir));
}
test.after(() => {
  for (const dir of tempDataDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('create()/list(): un profil créé apparaît dans list() avec running: false', () => {
  const manager = makeManager();
  const created = manager.create({ name: 'Alice', headless: true });
  assert.equal(created.running, false);
  assert.equal(created.connected, false);

  const listed = manager.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);
});

test('launch()/stop(): reflète running/connected, réutilise le même profileDir à chaque lancement', async () => {
  const manager = makeManager();
  const created = manager.create({ name: 'Bob', headless: true });

  const launched = await manager.launch(created.id);
  assert.equal(launched.running, true);
  assert.equal(launched.connected, true);
  assert.equal(manager.getDetail(created.id).running, true);

  const stopped = await manager.stop(created.id);
  assert.equal(stopped.running, false);
  assert.equal(stopped.connected, false);

  // Relance : doit réutiliser le même dossier de profil (persistant), pas en créer un autre.
  await manager.launch(created.id);
  const cacheAfterRelaunch = manager.getCacheInfo(created.id);
  assert.ok(cacheAfterRelaunch.fileCount > 0, 'le profil relancé doit avoir écrit dans le même dossier persistant');
  await manager.stop(created.id);
});

test('launch(): idempotent si déjà actif (pas de double lancement)', async () => {
  const manager = makeManager();
  const created = manager.create({ name: 'Carol', headless: true });

  const first = await manager.launch(created.id);
  const second = await manager.launch(created.id);
  assert.equal(first.running, true);
  assert.equal(second.running, true);

  await manager.stop(created.id);
});

test('launch(): persiste lastLaunchResult en succès et en échec', async () => {
  const manager = makeManager();
  const ok = manager.create({ name: 'Dave', headless: true });
  await manager.launch(ok.id);
  assert.equal(manager.getDetail(ok.id).lastLaunchResult?.ok, true);
  await manager.stop(ok.id);

  const bad = manager.create({ name: 'Eve', headless: true, device: 'ce-device-n-existe-pas' });
  await assert.rejects(() => manager.launch(bad.id));
  const detail = manager.getDetail(bad.id);
  assert.equal(detail.lastLaunchResult?.ok, false);
  assert.ok(detail.lastLaunchResult?.error);
});

test('clearCache(): arrête le profil actif puis vide son dossier, garde le record', async () => {
  const manager = makeManager();
  const created = manager.create({ name: 'Frank', headless: true });
  await manager.launch(created.id);
  assert.ok(manager.getCacheInfo(created.id).fileCount > 0);

  const status = await manager.clearCache(created.id);
  assert.equal(status.running, false);
  assert.equal(manager.getCacheInfo(created.id).fileCount, 0);
  assert.equal(manager.getDetail(created.id).name, 'Frank'); // le record survit
});

test('deleteProfile(): arrête si actif, supprime dossier + record', async () => {
  const manager = makeManager();
  const created = manager.create({ name: 'Grace', headless: true });
  await manager.launch(created.id);
  const dir = manager.getCacheInfo(created.id).path;

  await manager.deleteProfile(created.id);
  assert.equal(manager.list().find((p) => p.id === created.id), undefined);
  assert.equal(fs.existsSync(dir), false);
});

test('updateSettings(): persiste sans exiger que le profil soit arrêté ou actif', () => {
  const manager = makeManager();
  const created = manager.create({ name: 'Heidi' });
  const proxy = { server: 'http://127.0.0.1:9999' };

  const updated = manager.updateSettings(created.id, { proxy, headless: false });
  assert.deepEqual(updated.proxy, proxy);
  assert.equal(updated.headless, false);
});

test('bulk(): un id invalide au milieu du lot n\'empêche pas les autres de réussir', async () => {
  const manager = makeManager();
  const a = manager.create({ name: 'A', headless: true });
  const b = manager.create({ name: 'B', headless: true });

  const results = await manager.bulk([a.id, 'id-inexistant', b.id], 'launch');

  assert.equal(results.find((r) => r.id === a.id)?.ok, true);
  assert.equal(results.find((r) => r.id === 'id-inexistant')?.ok, false);
  assert.equal(results.find((r) => r.id === b.id)?.ok, true);
  assert.equal(manager.getDetail(a.id).running, true);
  assert.equal(manager.getDetail(b.id).running, true);

  await manager.bulk([a.id, b.id], 'stop');
});

test('bulk(): "set-proxy" applique le même proxy à tous les profils sélectionnés', () => {
  const manager = makeManager();
  const a = manager.create({ name: 'A' });
  const b = manager.create({ name: 'B' });
  const proxy = { server: 'http://127.0.0.1:8888' };

  return manager.bulk([a.id, b.id], 'set-proxy', { proxy }).then((results) => {
    assert.ok(results.every((r) => r.ok));
    assert.deepEqual(manager.getDetail(a.id).proxy, proxy);
    assert.deepEqual(manager.getDetail(b.id).proxy, proxy);
  });
});

test('getCacheInfo(): lève pour un id inconnu, comme getDetail()', () => {
  const manager = makeManager();
  assert.throws(() => manager.getCacheInfo('id-inexistant'), /inconnu/);
  assert.throws(() => manager.getDetail('id-inexistant'), /inconnu/);
});
