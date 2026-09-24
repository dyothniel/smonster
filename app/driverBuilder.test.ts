import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
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

// --- Bruit WebGL (readPixels) déterministe par profil ------------------------------------

async function readWebglFingerprint(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const gl = canvas.getContext('webgl') as WebGLRenderingContext;
    gl.clearColor(0.4, 0.6, 0.8, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const pixels = new Uint8Array(32 * 32 * 4);
    gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return Array.from(pixels);
  });
}

test('bruit WebGL: deux profils différents ont un readPixels différent', async () => {
  const builderA = new DriverBuilder({ baseProfileDir: makeTempProfileRoot(), headless: true, maxRetries: 1 });
  const builderB = new DriverBuilder({ baseProfileDir: makeTempProfileRoot(), headless: true, maxRetries: 1 });
  const driverA = await builderA.build();
  const driverB = await builderB.build();
  try {
    const fpA = await readWebglFingerprint(driverA.page);
    const fpB = await readWebglFingerprint(driverB.page);
    assert.notDeepEqual(fpA, fpB, 'deux profils distincts doivent avoir un readPixels WebGL différent');
  } finally {
    await DriverBuilder.quit(driverA.context);
    await DriverBuilder.quit(driverB.context);
  }
});

test('bruit WebGL: un même profil (chemin fixe) garde le même readPixels à chaque relance', async () => {
  const fixedDir = path.join(makeTempProfileRoot(), 'stable-webgl-profile');
  const buildOnce = async () => {
    const builder = new DriverBuilder({ profileDir: fixedDir, headless: true, maxRetries: 1 });
    const driver = await builder.build();
    const fp = await readWebglFingerprint(driver.page);
    await DriverBuilder.quit(driver.context);
    return fp;
  };
  const fp1 = await buildOnce();
  const fp2 = await buildOnce();
  assert.deepEqual(fp1, fp2, 'le même profil relancé doit garder le même readPixels WebGL');
});

// --- Bruit audio (AudioBuffer.getChannelData) déterministe par profil --------------------

async function readAudioFingerprint(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const ctx = new OfflineAudioContext(1, 5000, 44100);
    const oscillator = ctx.createOscillator();
    oscillator.type = 'triangle';
    oscillator.frequency.value = 10000;
    const compressor = ctx.createDynamicsCompressor();
    oscillator.connect(compressor);
    compressor.connect(ctx.destination);
    oscillator.start(0);
    const buffer = await ctx.startRendering();
    return Array.from(buffer.getChannelData(0).slice(0, 200));
  });
}

test('bruit audio: deux profils différents ont un fingerprint audio différent', async () => {
  const builderA = new DriverBuilder({ baseProfileDir: makeTempProfileRoot(), headless: true, maxRetries: 1 });
  const builderB = new DriverBuilder({ baseProfileDir: makeTempProfileRoot(), headless: true, maxRetries: 1 });
  const driverA = await builderA.build();
  const driverB = await builderB.build();
  try {
    const fpA = await readAudioFingerprint(driverA.page);
    const fpB = await readAudioFingerprint(driverB.page);
    assert.notDeepEqual(fpA, fpB, 'deux profils distincts doivent avoir un fingerprint audio différent');
  } finally {
    await DriverBuilder.quit(driverA.context);
    await DriverBuilder.quit(driverB.context);
  }
});

test('bruit audio: un même profil (chemin fixe) garde le même fingerprint audio à chaque relance', async () => {
  const fixedDir = path.join(makeTempProfileRoot(), 'stable-audio-profile');
  const buildOnce = async () => {
    const builder = new DriverBuilder({ profileDir: fixedDir, headless: true, maxRetries: 1 });
    const driver = await builder.build();
    const fp = await readAudioFingerprint(driver.page);
    await DriverBuilder.quit(driver.context);
    return fp;
  };
  const fp1 = await buildOnce();
  const fp2 = await buildOnce();
  assert.deepEqual(fp1, fp2, 'le même profil relancé doit garder le même fingerprint audio');
});

// --- Anti-fuite WebRTC --------------------------------------------------------------------

/**
 * Collecte les candidats ICE via `onicecandidate` (candidats `host` : purement locaux, aucun
 * serveur STUN/réseau externe requis — testable hors-ligne, comme vérifié empiriquement en
 * confirmant qu'un Chromium non patché produit bien un candidat `typ host` dans cet environnement).
 */
async function collectIceCandidates(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    return new Promise<string[]>((resolve) => {
      const pc = new RTCPeerConnection();
      const candidates: string[] = [];
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          candidates.push(event.candidate.candidate);
        } else {
          resolve(candidates); // fin de la collecte (candidate === null)
        }
      };
      pc.createDataChannel('leak-test');
      pc.createOffer().then((offer) => pc.setLocalDescription(offer));
      setTimeout(() => resolve(candidates), 4000); // filet de sécurité si l'event de fin n'arrive jamais
    });
  });
}

test("anti-fuite WebRTC: aucun candidat ICE host/srflx/prflx ne fuite via onicecandidate", async () => {
  const builder = new DriverBuilder({ baseProfileDir: makeTempProfileRoot(), headless: true, maxRetries: 1 });
  const driver = await builder.build();
  try {
    const candidates = await collectIceCandidates(driver.page);
    const leaky = candidates.filter((c) => /typ (host|srflx|prflx)/.test(c));
    assert.deepEqual(leaky, [], `candidats qui fuitent une IP hors proxy : ${JSON.stringify(leaky)}`);
  } finally {
    await DriverBuilder.quit(driver.context);
  }
});

test('anti-fuite WebRTC: RTCPeerConnection reste présent et fonctionnel (pas juste supprimé)', async () => {
  // Supprimer purement et simplement RTCPeerConnection serait lui-même un signal suspect —
  // on vérifie qu'il existe toujours et peut créer un data channel normalement.
  const builder = new DriverBuilder({ baseProfileDir: makeTempProfileRoot(), headless: true, maxRetries: 1 });
  const driver = await builder.build();
  try {
    const info = await driver.page.evaluate(() => {
      const pc = new RTCPeerConnection();
      const channel = pc.createDataChannel('test');
      return { hasRTC: typeof RTCPeerConnection === 'function', channelLabel: channel.label };
    });
    assert.equal(info.hasRTC, true);
    assert.equal(info.channelLabel, 'test');
  } finally {
    await DriverBuilder.quit(driver.context);
  }
});

// --- Défense fingerprint de polices --------------------------------------------------------

async function measureFont(page: Page, font: string): Promise<number> {
  return page.evaluate((f) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = `72px ${f}, monospace`;
    return ctx.measureText('mmmmmmmmmmlli').width;
  }, font);
}

test("fingerprint de polices: sur un profil desktop (Windows), Arial semble installée mais pas une police Linux (DejaVu Sans)", async () => {
  const builder = new DriverBuilder({ baseProfileDir: makeTempProfileRoot(), headless: true, maxRetries: 1 });
  const driver = await builder.build();
  try {
    const baseline = await measureFont(driver.page, '__nonexistent_probe_font__');
    const arial = await measureFont(driver.page, 'Arial');
    const dejavu = await measureFont(driver.page, 'DejaVu Sans');
    const liberation = await measureFont(driver.page, 'Liberation Sans');

    assert.notEqual(arial, baseline, 'Arial doit sembler installée sur un profil Windows');
    assert.equal(dejavu, baseline, "DejaVu Sans (police Linux) ne doit pas sembler installée sur Windows");
    assert.equal(liberation, baseline, "Liberation Sans (police Linux) ne doit pas sembler installée sur Windows");

    const fontsCheckArial = await driver.page.evaluate(() => document.fonts.check('72px Arial'));
    const fontsCheckDejaVu = await driver.page.evaluate(() => document.fonts.check('72px DejaVu Sans'));
    assert.equal(fontsCheckArial, true);
    assert.equal(fontsCheckDejaVu, false);
  } finally {
    await DriverBuilder.quit(driver.context);
  }
});

test('fingerprint de polices: sur un profil Android, Roboto semble installée mais pas une police Windows (Segoe UI)', async () => {
  const builder = new DriverBuilder({
    baseProfileDir: makeTempProfileRoot(),
    headless: true,
    device: 'Pixel 7',
    maxRetries: 1,
  });
  const driver = await builder.build();
  try {
    const baseline = await measureFont(driver.page, '__nonexistent_probe_font__');
    const roboto = await measureFont(driver.page, 'Roboto');
    const segoeUi = await measureFont(driver.page, 'Segoe UI');

    assert.notEqual(roboto, baseline, 'Roboto doit sembler installée sur un profil Android');
    assert.equal(segoeUi, baseline, "Segoe UI (police Windows) ne doit pas sembler installée sur Android");
  } finally {
    await DriverBuilder.quit(driver.context);
  }
});

test(
  "fingerprint de polices: sur webkit/macOS, Helvetica Neue et Menlo semblent installées grâce à l'alias fontconfig (scripts/setup-fonts.sh)",
  { skip: !webkitInstalled && 'binaire webkit non installé (npx playwright install webkit)' },
  async () => {
    const builder = new DriverBuilder({
      baseProfileDir: makeTempProfileRoot(),
      headless: true,
      device: 'Desktop Safari',
      maxRetries: 1,
    });
    const driver = await builder.build();
    try {
      const baseline = await measureFont(driver.page, '__nonexistent_probe_font__');
      const helveticaNeue = await measureFont(driver.page, 'Helvetica Neue');
      const menlo = await measureFont(driver.page, 'Menlo');
      const roboto = await measureFont(driver.page, 'Roboto');

      assert.notEqual(
        helveticaNeue,
        baseline,
        "Helvetica Neue doit sembler installée sur macOS (nécessite scripts/setup-fonts.sh)"
      );
      assert.notEqual(menlo, baseline, 'Menlo doit sembler installée sur macOS (nécessite scripts/setup-fonts.sh)');
      assert.equal(roboto, baseline, "Roboto (police Android) ne doit pas sembler installée sur macOS");
    } finally {
      await DriverBuilder.quit(driver.context);
    }
  }
);

// --- navigator.platform / navigator.languages ---------------------------------------------
// Bugs trouvés en testant contre bot.sannysoft.com/CreepJS sur un vrai profil : `navigator
// .platform` valait "Linux x86_64" malgré un UA Windows, et `navigator.languages` valait
// ["en-US","en"] même avec `locale: 'fr-FR'` (valeur figée par le plugin stealth, indépendante
// de la vraie locale — cf. doc de `applyNavigatorOverrides` dans driverBuilder.ts).

test('navigator.platform/languages: profil desktop (Windows) — cohérents avec la vraie locale configurée', async () => {
  const builder = new DriverBuilder({
    baseProfileDir: makeTempProfileRoot(),
    headless: true,
    locale: 'de-DE',
    maxRetries: 1,
  });
  const driver = await builder.build();
  try {
    const info = await driver.page.evaluate(() => ({
      platform: navigator.platform,
      language: navigator.language,
      languages: navigator.languages,
    }));
    assert.equal(info.platform, 'Win32');
    assert.equal(info.language, 'de-DE');
    assert.deepEqual(info.languages, ['de-DE', 'de']);
  } finally {
    await DriverBuilder.quit(driver.context);
  }
});

test('navigator.platform: profil Android — "Linux armv8l", pas la vraie plateforme hôte', async () => {
  const builder = new DriverBuilder({
    baseProfileDir: makeTempProfileRoot(),
    headless: true,
    device: 'Pixel 7',
    maxRetries: 1,
  });
  const driver = await builder.build();
  try {
    const platform = await driver.page.evaluate(() => navigator.platform);
    assert.equal(platform, 'Linux armv8l');
  } finally {
    await DriverBuilder.quit(driver.context);
  }
});

// --- Client Hints (navigator.userAgentData) -------------------------------------------------
// `getHighEntropyValues()` révélait littéralement la marque "HeadlessChrome" (constaté via
// CreepJS) — nécessite un contexte sécurisé (HTTPS), d'où la navigation vers une vraie page.

test('Client Hints: ne révèlent pas "Headless", cohérents avec la plateforme et la version de navigator.userAgent', async () => {
  const builder = new DriverBuilder({ baseProfileDir: makeTempProfileRoot(), headless: true, maxRetries: 1 });
  const driver = await builder.build();
  try {
    await driver.page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const info = await driver.page.evaluate(async () => {
      if (!('userAgentData' in navigator)) return null;
      const hev = await (navigator as any).userAgentData.getHighEntropyValues(['platform', 'uaFullVersion']);
      return { brands: (navigator as any).userAgentData.brands, platform: (navigator as any).userAgentData.platform, hev };
    });
    assert.ok(info, 'navigator.userAgentData doit exister sur un contexte sécurisé (Chromium)');
    const brandNames = info!.brands.map((b: { brand: string }) => b.brand).join(',');
    assert.doesNotMatch(brandNames, /Headless/i);
    assert.equal(info!.platform, 'Windows');
    assert.doesNotMatch(info!.hev.uaFullVersion, /Headless/i);
  } finally {
    await DriverBuilder.quit(driver.context);
  }
});

// --- Fingerprint des Web Workers -------------------------------------------------------------
// Découvert via CreepJS : un Worker dédié rapportait le VRAI navigator.userAgent
// ("HeadlessChrome"/Linux), navigator.platform ("Linux x86_64") et navigator.hardwareConcurrency
// (le vrai nombre de coeurs hôte), contournant tout le reste de la furtivité.

test('fingerprint des Workers: un worker construit depuis un blob: reflète les valeurs déjà spoofées du thread principal', async () => {
  const builder = new DriverBuilder({ baseProfileDir: makeTempProfileRoot(), headless: true, maxRetries: 1 });
  const driver = await builder.build();
  try {
    const [main, worker] = await driver.page.evaluate(() => {
      const mainInfo = {
        ua: navigator.userAgent,
        platform: navigator.platform,
        cores: navigator.hardwareConcurrency,
      };
      const workerInfo = new Promise((resolve) => {
        const blob = new Blob(
          ['self.postMessage({ua: navigator.userAgent, platform: navigator.platform, cores: navigator.hardwareConcurrency})'],
          { type: 'application/javascript' }
        );
        const w = new Worker(URL.createObjectURL(blob));
        w.onmessage = (e) => resolve(e.data);
        w.onerror = () => resolve({ error: true });
        setTimeout(() => resolve({ timeout: true }), 5000);
      });
      return Promise.all([mainInfo, workerInfo]);
    });
    assert.deepEqual(worker, main, 'le worker doit voir exactement les mêmes valeurs (déjà spoofées) que le thread principal');
    assert.doesNotMatch((worker as any).ua, /Headless/i);
  } finally {
    await DriverBuilder.quit(driver.context);
  }
});

// --- Fingerprint des Service Workers -----------------------------------------------------
// Découvert en re-testant contre CreepJS après le correctif des Workers dédiés ci-dessus : elle
// fingerprinte en réalité depuis un SERVICE Worker (`navigator.serviceWorker.register()`), un
// mécanisme différent (persistant, rattaché à l'origine, jamais instanciable depuis un blob:) que
// `patchWorkerFingerprint` (qui n'intercepte QUE le constructeur `Worker`) ne peut structurellement
// pas atteindre. Corrigé au niveau réseau via `context.route()`, en ciblant uniquement les
// requêtes pour lesquelles `request.serviceWorker()` est non-null (cf. doc de
// `patchServiceWorkerFingerprint` dans driverBuilder.ts) pour ne jamais toucher aux scripts
// normaux d'un site (risque de casser leur Subresource Integrity). Un vrai serveur HTTP local est
// nécessaire ici : un Service Worker ne peut pas être enregistré depuis une page mockée par
// `page.route()`/blob:, contrairement aux tests ci-dessus.
test('fingerprint des Service Workers: reflète les valeurs déjà spoofées du thread principal (patch réseau)', async () => {
  const swServer = http.createServer((req, res) => {
    if (req.url === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(`
        self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
        self.addEventListener('message', async (e) => {
          let userAgentData = null;
          if ('userAgentData' in navigator) {
            const hev = await navigator.userAgentData.getHighEntropyValues(['platform', 'uaFullVersion']);
            userAgentData = { brands: navigator.userAgentData.brands, platform: navigator.userAgentData.platform, hev };
          }
          e.ports[0].postMessage({
            ua: navigator.userAgent,
            platform: navigator.platform,
            cores: navigator.hardwareConcurrency,
            userAgentData,
          });
        });
      `);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body>ok</body></html>');
    }
  });
  await new Promise<void>((resolve) => swServer.listen(0, '127.0.0.1', () => resolve()));
  const address = swServer.address();
  if (address === null || typeof address === 'string') throw new Error('adresse de serveur HTTP inattendue');
  const swOrigin = `http://127.0.0.1:${address.port}`;

  const builder = new DriverBuilder({ baseProfileDir: makeTempProfileRoot(), headless: true, maxRetries: 1 });
  const driver = await builder.build();
  try {
    await driver.page.goto(`${swOrigin}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await driver.page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
          setTimeout(resolve, 5000);
        });
      }
    });

    const hasController = await driver.page.evaluate(() => !!navigator.serviceWorker.controller);
    assert.ok(hasController, 'le Service Worker doit avoir pris le contrôle de la page (clients.claim())');

    const main = await driver.page.evaluate(async () => {
      let userAgentData = null;
      if ('userAgentData' in navigator) {
        const hev = await (navigator as any).userAgentData.getHighEntropyValues(['platform', 'uaFullVersion']);
        userAgentData = { brands: (navigator as any).userAgentData.brands, platform: (navigator as any).userAgentData.platform, hev };
      }
      return { ua: navigator.userAgent, platform: navigator.platform, cores: navigator.hardwareConcurrency, userAgentData };
    });
    const sw = await driver.page.evaluate(() => {
      return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (e) => resolve(e.data);
        navigator.serviceWorker.controller!.postMessage({ cmd: 'fingerprint' }, [channel.port2]);
        setTimeout(() => resolve({ timeout: true }), 5000);
      });
    });

    assert.deepEqual(sw, main, 'le Service Worker doit voir exactement les mêmes valeurs (déjà spoofées) que le thread principal');
    assert.doesNotMatch((sw as any).ua, /Headless/i);
    if ((sw as any).userAgentData) {
      const brandNames = (sw as any).userAgentData.brands.map((b: { brand: string }) => b.brand).join(',');
      assert.doesNotMatch(brandNames, /Headless/i);
    }
  } finally {
    await DriverBuilder.quit(driver.context);
    await new Promise<void>((resolve) => swServer.close(() => resolve()));
  }
});

// --- En-tête HTTP Sec-CH-UA ----------------------------------------------------------------
// Découvert en inspectant les en-têtes bruts réellement envoyés sur le réseau (via tls.peet.ws) :
// Chromium calcule lui-même cet en-tête à partir du binaire réellement exécuté (le build
// headless) et y met "HeadlessChrome" en clair, sur CHAQUE requête, dès la toute première —
// totalement invisible à un test purement côté page (CreepJS y compris) puisque c'est un en-tête
// SORTANT, jamais un test JS ne peut lire ses propres en-têtes de requête. cf. doc de
// `computeCorrectedSecChUa`/`patchServiceWorkerFingerprint` dans driverBuilder.ts.

test('en-tête HTTP Sec-CH-UA: ne révèle pas "Headless", même sur la toute première requête', async () => {
  let capturedHeaders: http.IncomingHttpHeaders | null = null;
  const server = http.createServer((req, res) => {
    capturedHeaders = req.headers;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body>ok</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('adresse de serveur HTTP inattendue');

  const builder = new DriverBuilder({ baseProfileDir: makeTempProfileRoot(), headless: true, maxRetries: 1 });
  const driver = await builder.build();
  try {
    await driver.page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    assert.ok(capturedHeaders, 'le serveur local doit avoir reçu la requête de navigation');
    const secChUa = capturedHeaders!['sec-ch-ua'];
    assert.ok(secChUa, 'Sec-CH-UA doit être envoyé par défaut par Chromium');
    assert.doesNotMatch(secChUa as string, /Headless/i);
    assert.match(secChUa as string, /Google Chrome/);
  } finally {
    await DriverBuilder.quit(driver.context);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
