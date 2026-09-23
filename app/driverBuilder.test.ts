import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { webkit } from 'playwright-extra';
import type { Page } from 'playwright';
import { DriverBuilder, resolveEngineForDevice, hashToSeed } from './driverBuilder';
import { ProxyRotator } from './proxyRotator';

// --- resolveEngineForDevice : routing pur, sans navigateur -----------------------------
// Ce sont les tests les plus importants de ce fichier : ils verrouillent le comportement au
// coeur de "l'iOS tourne sous webkit" sans dépendre d'un binaire installé, donc ils tournent
// partout (CI, sandbox sans réseau...).

test('resolveEngineForDevice: "desktop" et un preset Android résolvent vers chromium', () => {
  assert.equal(resolveEngineForDevice('desktop'), 'chromium');
  assert.equal(resolveEngineForDevice('Pixel 7'), 'chromium');
});

test('resolveEngineForDevice: les presets iOS/Safari résolvent vers webkit', () => {
  assert.equal(resolveEngineForDevice('iPhone 15'), 'webkit');
  assert.equal(resolveEngineForDevice('Desktop Safari'), 'webkit');
});

test('resolveEngineForDevice: un preset Firefox est rejeté explicitement', () => {
  assert.throws(() => resolveEngineForDevice('Desktop Firefox'), /Firefox/);
});

test('resolveEngineForDevice: un device inconnu est rejeté explicitement', () => {
  // Le type de `device` a un index signature ([key: string]: DeviceDescriptor) côté
  // Playwright, donc un nom invalide est valide au sens de tsc — la validation est purement
  // runtime, d'où ce test.
  assert.throws(() => resolveEngineForDevice('ce-device-n-existe-pas'), /Device inconnu/);
});

// --- build() : bout en bout avec Chromium (toujours installé dans cet environnement) ---

const tempProfileRoots: string[] = [];
function makeTempProfileRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driverbuilder-test-'));
  tempProfileRoots.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempProfileRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('build(): device inconnu échoue vite, sans jamais tenter de lancer un navigateur', async () => {
  const builder = new DriverBuilder({
    baseProfileDir: makeTempProfileRoot(),
    device: 'ce-device-n-existe-pas',
    maxRetries: 1,
  });
  await assert.rejects(() => builder.build(), /Device inconnu/);
});

test('build(): device "desktop" headless a un UA propre (pas de HeadlessChrome/Linux)', async () => {
  const builder = new DriverBuilder({
    baseProfileDir: makeTempProfileRoot(),
    headless: true,
    maxRetries: 1,
  });
  const { context, page } = await builder.build();
  try {
    const ua = await page.evaluate(() => navigator.userAgent);
    assert.doesNotMatch(ua, /Headless/);
    assert.doesNotMatch(ua, /Linux/);
    assert.match(ua, /Chrome\//);

    const isWebdriver = await page.evaluate(() => navigator.webdriver);
    assert.equal(isWebdriver, false);
  } finally {
    await DriverBuilder.quit(context);
  }
});

test('build(): device Android garde son UA (non écrasé par un UA desktop)', async () => {
  const builder = new DriverBuilder({
    baseProfileDir: makeTempProfileRoot(),
    headless: true,
    device: 'Pixel 7',
    maxRetries: 1,
  });
  const { context, page } = await builder.build();
  try {
    const ua = await page.evaluate(() => navigator.userAgent);
    assert.match(ua, /Android/);
    assert.match(ua, /Pixel 7/);
    assert.doesNotMatch(ua, /Windows/);
  } finally {
    await DriverBuilder.quit(context);
  }
});

test('build(): les évasions stealth au niveau page (webgl.vendor) s\'appliquent bien sur la page retournée', async () => {
  // Régression : l'onglet auto-ouvert par launchPersistentContext ne passe pas par le hook
  // onPageCreated de playwright-extra, donc les évasions stealth n'y étaient pas appliquées.
  const builder = new DriverBuilder({
    baseProfileDir: makeTempProfileRoot(),
    headless: true,
    maxRetries: 1,
  });
  const { context, page } = await builder.build();
  try {
    const vendor = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') as WebGLRenderingContext | null;
      const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
      return dbg ? gl!.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null;
    });
    assert.notEqual(vendor, 'Google Inc. (Google)');
  } finally {
    await DriverBuilder.quit(context);
  }
});

// --- WebKit : ne tourne que si le binaire est installé (`npx playwright install webkit`) ---

const webkitInstalled = fs.existsSync(webkit.executablePath());

test(
  'build(): un preset iOS tourne sous webkit, sans artefacts Chrome qui trahiraient le déguisement',
  { skip: !webkitInstalled && 'binaire webkit non installé (npx playwright install webkit)' },
  async () => {
    const builder = new DriverBuilder({
      baseProfileDir: makeTempProfileRoot(),
      headless: true,
      device: 'iPhone 15',
      maxRetries: 1,
    });
    const { context, page } = await builder.build();
    try {
      const ua = await page.evaluate(() => navigator.userAgent);
      assert.match(ua, /iPhone/);
      assert.match(ua, /Safari/);
      assert.doesNotMatch(ua, /Chrome/);

      const isWebdriver = await page.evaluate(() => navigator.webdriver);
      assert.ok(isWebdriver === false || isWebdriver === undefined);

      // Un vrai Safari n'a jamais `window.chrome` : si ça apparaît, une évasion Chromium a
      // fuité vers le stealth WebKit (cf. GENERIC_STEALTH_EVASIONS dans driverBuilder.ts).
      const hasChromeGlobal = await page.evaluate(() => 'chrome' in window);
      assert.equal(hasChromeGlobal, false);
    } finally {
      await DriverBuilder.quit(context);
    }
  }
);

test(
  'build(): un preset Desktop Firefox est rejeté avant tout lancement',
  async () => {
    const builder = new DriverBuilder({
      baseProfileDir: makeTempProfileRoot(),
      device: 'Desktop Firefox',
      maxRetries: 1,
    });
    await assert.rejects(() => builder.build(), /Firefox/);
  }
);

// --- proxy / proxyRotator ---------------------------------------------------------------

test('constructeur: `proxy` et `proxyRotator` sont mutuellement exclusifs', () => {
  const rotator = new ProxyRotator({ proxies: [{ server: 'http://127.0.0.1:1' }] });
  assert.throws(
    () =>
      new DriverBuilder({
        baseProfileDir: makeTempProfileRoot(),
        proxy: { server: 'http://127.0.0.1:1' },
        proxyRotator: rotator,
      }),
    /mutuellement exclusifs/
  );
});

test('build(): expose sur BuiltDriver le proxy statique effectivement utilisé', async () => {
  const proxy = { server: 'http://127.0.0.1:1' };
  const builder = new DriverBuilder({
    baseProfileDir: makeTempProfileRoot(),
    headless: true,
    proxy,
    maxRetries: 1,
  });
  const { context, proxy: usedProxy } = await builder.build();
  try {
    assert.equal(usedProxy, proxy);
  } finally {
    await DriverBuilder.quit(context);
  }
});

test('build() + proxyRotator: un proxy mort est détecté par un vrai goto() (pas par healthCheck), et rapportable au rotator', async () => {
  // Vérifié empiriquement : Chromium démarre sans erreur avec un proxy injoignable, et
  // `healthCheck()` (about:blank uniquement) ne le détecte pas non plus puisque about:blank
  // n'est jamais proxifié. C'est pour ça que `BuiltDriver.proxy` existe : sans lui, l'appelant
  // n'aurait aucun moyen de savoir quel proxy blâmer après un vrai échec réseau.
  const deadProxy = { server: 'http://127.0.0.1:1' }; // port fermé localement, échec immédiat
  const rotator = new ProxyRotator({ proxies: [deadProxy], maxConsecutiveFailures: 1 });
  const builder = new DriverBuilder({
    baseProfileDir: makeTempProfileRoot(),
    headless: true,
    proxyRotator: rotator,
    maxRetries: 1,
  });

  const driver = await builder.build(); // réussit : healthCheck ne traverse pas le proxy
  assert.equal(driver.proxy, deadProxy);

  try {
    await assert.rejects(
      () => driver.page.goto('http://example.invalid', { timeout: 5000 }),
      /PROXY/
    );
    assert.ok(driver.proxy);
    rotator.reportFailure(driver.proxy!);
    assert.equal(rotator.availableCount, 0);
  } finally {
    await DriverBuilder.quit(driver.context);
  }
});

// --- profileDir : profils nommés/persistants (chemin fixe, jamais supprimé automatiquement) ---

test("profileDir: le dossier fixe n'est jamais supprimé après quit(), même avec keepProfile: false explicite", async () => {
  const root = makeTempProfileRoot();
  const fixedDir = path.join(root, 'named-profile');
  const builder = new DriverBuilder({
    profileDir: fixedDir,
    headless: true,
    keepProfile: false, // explicite : même ainsi, un profileDir fixe ne doit jamais être supprimé
    maxRetries: 1,
  });
  const { context, profileDir } = await builder.build();
  assert.equal(profileDir, fixedDir);

  await DriverBuilder.quit(context);
  assert.ok(fs.existsSync(fixedDir), 'le dossier de profil fixe doit survivre à quit()');
});

test("profileDir: un échec de tentative ne supprime jamais le dossier fixe (contrairement à un dossier éphémère)", async () => {
  const root = makeTempProfileRoot();
  const fixedDir = path.join(root, 'named-profile-retry');
  fs.mkdirSync(fixedDir, { recursive: true });
  const markerPath = path.join(fixedDir, 'marker.txt');
  fs.writeFileSync(markerPath, 'cookies-et-autres-donnees-precieuses');

  const builder = new DriverBuilder({
    profileDir: fixedDir,
    device: 'ce-device-n-existe-pas', // échoue avant tout lancement, à chaque tentative
    maxRetries: 2,
  });
  await assert.rejects(() => builder.build(), /Device inconnu/);

  assert.ok(
    fs.existsSync(markerPath),
    'le marqueur doit survivre à un échec de tentative sur un profil à chemin fixe'
  );
});

test('profileDir: un dossier éphémère (comportement par défaut) reste bien supprimé après un échec de tentative', async () => {
  // Contre-exemple pour verrouiller que la garde `ephemeral` ne casse pas le nettoyage normal.
  const root = makeTempProfileRoot();
  const builder = new DriverBuilder({
    baseProfileDir: root,
    device: 'ce-device-n-existe-pas',
    maxRetries: 1,
  });
  await assert.rejects(() => builder.build(), /Device inconnu/);

  assert.deepEqual(fs.readdirSync(root), [], 'le dossier éphémère raté doit avoir été nettoyé');
});

// --- Bruit de canvas déterministe par profil --------------------------------------------

test('hashToSeed(): déterministe, et des chaînes différentes donnent des seeds différentes', () => {
  assert.equal(hashToSeed('profile-a'), hashToSeed('profile-a'));
  assert.notEqual(hashToSeed('profile-a'), hashToSeed('profile-b'));
});

async function readCanvasFingerprint(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 220;
    canvas.height = 30;
    const ctx = canvas.getContext('2d')!;
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(0, 0, 100, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('Canvas fingerprint test', 2, 15);
    return canvas.toDataURL();
  });
}

test('bruit canvas: deux profils différents (même device/proxy/timezone) ont un fingerprint canvas différent', async () => {
  const builderA = new DriverBuilder({ baseProfileDir: makeTempProfileRoot(), headless: true, maxRetries: 1 });
  const builderB = new DriverBuilder({ baseProfileDir: makeTempProfileRoot(), headless: true, maxRetries: 1 });
  const driverA = await builderA.build();
  const driverB = await builderB.build();
  try {
    const fpA = await readCanvasFingerprint(driverA.page);
    const fpB = await readCanvasFingerprint(driverB.page);
    assert.notEqual(fpA, fpB, 'deux profils distincts doivent avoir un fingerprint canvas différent');
  } finally {
    await DriverBuilder.quit(driverA.context);
    await DriverBuilder.quit(driverB.context);
  }
});

test('bruit canvas: un même profil (chemin fixe) garde le même fingerprint à chaque relance', async () => {
  const fixedDir = path.join(makeTempProfileRoot(), 'stable-profile');
  const buildOnce = async () => {
    const builder = new DriverBuilder({ profileDir: fixedDir, headless: true, maxRetries: 1 });
    const driver = await builder.build();
    const fp = await readCanvasFingerprint(driver.page);
    await DriverBuilder.quit(driver.context);
    return fp;
  };
  const fp1 = await buildOnce();
  const fp2 = await buildOnce();
  assert.equal(fp1, fp2, 'le même profil relancé doit garder le même fingerprint canvas');
});

test("bruit canvas: getImageData reste cohérent entre deux appels dans la même session (pas de hasard par appel)", async () => {
  const builder = new DriverBuilder({ baseProfileDir: makeTempProfileRoot(), headless: true, maxRetries: 1 });
  const driver = await builder.build();
  try {
    const [a, b] = await driver.page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 50;
      canvas.height = 50;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#123456';
      ctx.fillRect(0, 0, 50, 50);
      const d1 = Array.from(ctx.getImageData(0, 0, 50, 50).data);
      const d2 = Array.from(ctx.getImageData(0, 0, 50, 50).data);
      return [d1, d2];
    });
    assert.deepEqual(a, b, 'deux lectures du même canvas dans la même session doivent être identiques');
  } finally {
    await DriverBuilder.quit(driver.context);
  }
});
