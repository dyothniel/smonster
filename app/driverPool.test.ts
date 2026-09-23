import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DriverPool } from './driverPool';
import { DriverBuilder } from './driverBuilder';
import type { DriverBuilderOptions } from './driverBuilder';

const tempProfileRoots: string[] = [];
function baseOpts(): DriverBuilderOptions {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driverpool-test-'));
  tempProfileRoots.push(dir);
  return { baseProfileDir: dir, headless: true, maxRetries: 1 };
}
test.after(() => {
  for (const dir of tempProfileRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquire(): construit jusqu\'à maxConcurrent profils distincts, puis bloque', async () => {
  const pool = new DriverPool({ factory: baseOpts, maxConcurrent: 2 });

  const d1 = await pool.acquire();
  const d2 = await pool.acquire();
  assert.notEqual(d1.profileDir, d2.profileDir);
  assert.equal(pool.size, 2);
  assert.equal(pool.leasedCount, 2);

  let thirdResolved = false;
  const third = pool.acquire().then((d) => {
    thirdResolved = true;
    return d;
  });
  // Laisse tourner la boucle d'événements : le 3e acquire() ne doit pas s'être résolu, le
  // pool étant déjà à maxConcurrent.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(thirdResolved, false);

  await pool.release(d1);
  const d3 = await third;
  assert.equal(thirdResolved, true);
  assert.equal(d3.profileDir, d1.profileDir); // profil de d1 réutilisé, pas un nouveau

  await pool.release(d2);
  await pool.release(d3);
  await pool.drain();
});

test('release(): rend le même contexte persistant, mais une page fraîche', async () => {
  const pool = new DriverPool({ factory: baseOpts, maxConcurrent: 1 });

  const d1 = await pool.acquire();
  await d1.page.goto('about:blank');
  await d1.page.evaluate(() => {
    (window as any).__marker = 'still-here';
  });
  await pool.release(d1);

  const d2 = await pool.acquire();
  assert.equal(d2.context, d1.context); // même profil/contexte réutilisé
  assert.notEqual(d2.page, d1.page); // mais une page neuve pour la nouvelle tâche

  await pool.release(d2);
  await pool.drain();
});

test('release({ discard: true }): force le renouvellement du profil', async () => {
  const pool = new DriverPool({ factory: baseOpts, maxConcurrent: 1 });

  const d1 = await pool.acquire();
  await pool.release(d1, { discard: true });

  const d2 = await pool.acquire();
  assert.notEqual(d2.profileDir, d1.profileDir);

  await pool.release(d2);
  await pool.drain();
});

test('maxUsesPerProfile: recycle le profil après le nombre d\'utilisations autorisé', async () => {
  const pool = new DriverPool({ factory: baseOpts, maxConcurrent: 1, maxUsesPerProfile: 2 });

  const d1 = await pool.acquire();
  await pool.release(d1); // usage 1/2

  const d2 = await pool.acquire();
  assert.equal(d2.profileDir, d1.profileDir); // encore le même profil
  await pool.release(d2); // usage 2/2 -> recyclé

  const d3 = await pool.acquire();
  assert.notEqual(d3.profileDir, d2.profileDir); // nouveau profil

  await pool.release(d3);
  await pool.drain();
});

test('release() est idempotent (double release sans effet)', async () => {
  const pool = new DriverPool({ factory: baseOpts, maxConcurrent: 1 });
  const d1 = await pool.acquire();

  await pool.release(d1);
  assert.equal(pool.idleCount, 1);
  await pool.release(d1); // double release : ne doit pas dupliquer l'entrée idle
  assert.equal(pool.idleCount, 1);

  await pool.drain();
});

test('drain(): ferme les profils idle et rejette les acquire() suivants', async () => {
  const pool = new DriverPool({ factory: baseOpts, maxConcurrent: 1 });
  const d1 = await pool.acquire();
  await pool.release(d1);
  assert.equal(pool.idleCount, 1);

  await pool.drain();
  assert.equal(pool.idleCount, 0);
  assert.equal(d1.browser.isConnected(), false);

  await assert.rejects(() => pool.acquire(), /drain/);
});

test('acquireTimeoutMs: un acquire() qui ne peut pas aboutir échoue proprement', async () => {
  const pool = new DriverPool({ factory: baseOpts, maxConcurrent: 1, acquireTimeoutMs: 300 });
  const d1 = await pool.acquire(); // occupe l'unique slot, jamais release() dans ce test

  await assert.rejects(() => pool.acquire(), /timeout/);

  await pool.release(d1);
  await pool.drain();
});

test('acquire(): une erreur de build() ne bloque pas le slot (retenté sur un factory valide)', async () => {
  let calls = 0;
  const pool = new DriverPool({
    factory: () => {
      calls++;
      return calls === 1
        ? { device: 'ce-device-n-existe-pas', maxRetries: 1 } // échoue tout de suite
        : baseOpts();
    },
    maxConcurrent: 1,
  });

  await assert.rejects(() => pool.acquire(), /Device inconnu/);
  assert.equal(pool.size, 0); // le slot raté n'est pas resté compté

  const d = await pool.acquire(); // doit pouvoir reconstruire normalement ensuite
  assert.ok(d.browser.isConnected());

  await pool.release(d);
  await pool.drain();
});
