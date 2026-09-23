import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProxyRotator } from './proxyRotator';
import type { ProxyConfig } from './driverBuilder';

function proxies(n: number): ProxyConfig[] {
  return Array.from({ length: n }, (_, i) => ({ server: `http://proxy-${i}.example:8080` }));
}

test('constructeur: refuse une liste vide', () => {
  assert.throws(() => new ProxyRotator({ proxies: [] }), /au moins un proxy/);
});

test('round-robin: distribue les proxies dans l\'ordre, en boucle', () => {
  const [p0, p1, p2] = proxies(3);
  const rotator = new ProxyRotator({ proxies: [p0, p1, p2] });
  assert.deepEqual(
    [rotator.next(), rotator.next(), rotator.next(), rotator.next()],
    [p0, p1, p2, p0]
  );
});

test('random: pioche toujours parmi les proxies configurés', () => {
  const all = proxies(3);
  const rotator = new ProxyRotator({ proxies: all, strategy: 'random' });
  for (let i = 0; i < 20; i++) {
    assert.ok(all.includes(rotator.next()));
  }
});

test('reportFailure: exclut un proxy après maxConsecutiveFailures, round-robin saute par-dessus', () => {
  const [p0, p1] = proxies(2);
  const rotator = new ProxyRotator({ proxies: [p0, p1], maxConsecutiveFailures: 2 });

  rotator.reportFailure(p0);
  rotator.reportFailure(p0);
  assert.equal(rotator.availableCount, 1);

  // p0 est exclu : tous les next() suivants doivent retourner p1.
  assert.equal(rotator.next(), p1);
  assert.equal(rotator.next(), p1);
});

test('reportSuccess: remet à zéro le compteur d\'échecs (pas d\'exclusion prématurée)', () => {
  const [p0, p1] = proxies(2);
  const rotator = new ProxyRotator({ proxies: [p0, p1], maxConsecutiveFailures: 2 });

  rotator.reportFailure(p0);
  rotator.reportSuccess(p0);
  rotator.reportFailure(p0); // 1 seul échec consécutif depuis le reset : pas encore exclu
  assert.equal(rotator.availableCount, 2);
});

test('next(): lève quand tous les proxies sont exclus', () => {
  const [p0, p1] = proxies(2);
  const rotator = new ProxyRotator({ proxies: [p0, p1], maxConsecutiveFailures: 1 });
  rotator.reportFailure(p0);
  rotator.reportFailure(p1);
  assert.throws(() => rotator.next(), /aucun proxy disponible/);
});

test('cooldown: un proxy exclu redevient disponible une fois le délai passé', async () => {
  const [p0, p1] = proxies(2);
  const rotator = new ProxyRotator({
    proxies: [p0, p1],
    maxConsecutiveFailures: 1,
    cooldownMs: 50,
  });
  rotator.reportFailure(p0);
  assert.equal(rotator.availableCount, 1);

  await new Promise((r) => setTimeout(r, 80));
  assert.equal(rotator.availableCount, 2);
});

test('stickyKey: retourne le même proxy tant qu\'il reste disponible, indépendamment par clé', () => {
  const rotator = new ProxyRotator({ proxies: proxies(3) });
  const forA = rotator.next('slot-A');
  const forB = rotator.next('slot-B');
  for (let i = 0; i < 5; i++) {
    assert.equal(rotator.next('slot-A'), forA);
    assert.equal(rotator.next('slot-B'), forB);
  }
});

test('stickyKey: change de proxy une fois l\'assignation exclue, puis se re-fixe dessus', () => {
  const [p0, p1] = proxies(2);
  const rotator = new ProxyRotator({ proxies: [p0, p1], maxConsecutiveFailures: 1 });

  const first = rotator.next('slot-A');
  rotator.reportFailure(first);

  const second = rotator.next('slot-A');
  assert.notEqual(second, first);
  // Et ça reste fixé sur ce nouveau proxy tant qu'il est sain.
  assert.equal(rotator.next('slot-A'), second);
});
