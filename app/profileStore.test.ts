import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProfileStore } from './profileStore';

const tempDataDirs: string[] = [];
function makeTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profilestore-test-'));
  tempDataDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempDataDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('create(): applique les valeurs par défaut (headless: true, device: desktop, proxy: null)', () => {
  const store = new ProfileStore(makeTempDataDir());
  const record = store.create({ name: 'Alice' });
  assert.equal(record.name, 'Alice');
  assert.equal(record.headless, true);
  assert.equal(record.device, 'desktop');
  assert.equal(record.locale, 'fr-FR');
  assert.equal(record.timezoneId, 'Europe/Paris');
  assert.equal(record.proxy, null);
  assert.ok(record.id);
  assert.equal(record.createdAt, record.updatedAt);
});

test('list()/get(): retournent des copies défensives (pas de fuite de référence interne)', () => {
  const store = new ProfileStore(makeTempDataDir());
  const created = store.create({ name: 'Bob' });

  const fromGet = store.get(created.id)!;
  fromGet.name = 'MUTATED';
  assert.equal(store.get(created.id)!.name, 'Bob');

  const fromList = store.list()[0];
  fromList.name = 'MUTATED-TOO';
  assert.equal(store.get(created.id)!.name, 'Bob');
});

test('get(): undefined pour un id inconnu', () => {
  const store = new ProfileStore(makeTempDataDir());
  assert.equal(store.get('id-inexistant'), undefined);
});

test('update(): fusionne le patch, met à jour updatedAt, protège id/createdAt', async () => {
  const store = new ProfileStore(makeTempDataDir());
  const created = store.create({ name: 'Carol' });

  await new Promise((r) => setTimeout(r, 5)); // s'assurer que updatedAt diffère de createdAt
  const updated = store.update(created.id, {
    name: 'Carol 2',
    // @ts-expect-error -- id/createdAt ne font pas partie de UpdateProfileInput, justement.
    id: 'devrait-etre-ignore',
  });

  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.notEqual(updated.updatedAt, created.updatedAt);
  assert.equal(updated.name, 'Carol 2');
});

test('update(): lève pour un id inconnu', () => {
  const store = new ProfileStore(makeTempDataDir());
  assert.throws(() => store.update('id-inexistant', { name: 'x' }), /profil inconnu/);
});

test('remove(): supprime le record ; no-op défensif sur un id inconnu', () => {
  const store = new ProfileStore(makeTempDataDir());
  const created = store.create({ name: 'Dave' });

  store.remove('id-inexistant'); // ne doit pas lever
  assert.equal(store.list().length, 1);

  store.remove(created.id);
  assert.equal(store.get(created.id), undefined);
  assert.equal(store.list().length, 0);
});

test('browserProfileDir(): chemin dérivé et stable pour un même id', () => {
  const store = new ProfileStore(makeTempDataDir());
  const created = store.create({ name: 'Eve' });
  const dir1 = store.browserProfileDir(created.id);
  const dir2 = store.browserProfileDir(created.id);
  assert.equal(dir1, dir2);
  assert.ok(dir1.includes(created.id));
});

test('persistance: une 2e instance sur le même dataDir voit les mêmes records (simule un restart)', () => {
  const dataDir = makeTempDataDir();
  const store1 = new ProfileStore(dataDir);
  store1.create({ name: 'Frank' });
  store1.create({ name: 'Grace' });

  const store2 = new ProfileStore(dataDir);
  const names = store2
    .list()
    .map((r) => r.name)
    .sort();
  assert.deepEqual(names, ['Frank', 'Grace']);
});

test('persistance: profiles.json illisible (JSON invalide) lève une erreur claire', () => {
  const dataDir = makeTempDataDir();
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), '{ ceci n\'est pas du JSON valide');
  assert.throws(() => new ProfileStore(dataDir), /illisible/);
});
