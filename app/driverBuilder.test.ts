import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { webkit } from 'playwright-extra';
import { DriverBuilder, resolveEngineForDevice } from './driverBuilder';

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
