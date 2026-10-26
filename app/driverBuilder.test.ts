import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { webkit } from 'playwright';
import type { Page } from 'patchright';
import {
  DriverBuilder,
  resolveEngineForDevice,
  hashToSeed,
  mainWorldEvaluate,
  detectHostPlatformCategory,
} from './driverBuilder';

// Le device 'desktop' claim maintenant le VRAI système hôte (cf. doc de `detectHostPlatformCategory`
// dans driverBuilder.ts, et §4 de README.md) plutôt que "Windows" en dur — ces tests tournent donc
// potentiellement sur n'importe lequel des trois hosts détectables, jamais un seul supposé fixe.
const HOST_PLATFORM = detectHostPlatformCategory();
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

test('build(): device "desktop" headless a un UA propre (pas de HeadlessChrome), cohérent avec le host détecté', async () => {
  const builder = new DriverBuilder({
    baseProfileDir: makeTempProfileRoot(),
    headless: true,
    maxRetries: 1,
  });
  const { context, page } = await builder.build();
  try {
    const ua = await mainWorldEvaluate(page, () => navigator.userAgent, 'chromium');
    assert.doesNotMatch(ua, /Headless/);
    assert.match(ua, /Chrome\//);
    // L'UA doit correspondre au système RÉELLEMENT détecté (cf. `detectHostPlatformCategory`),
    // jamais aux deux autres — une incohérence ici serait exactement le genre de fuite
    // (`platformMismatch`) qu'on a corrigée.
    if (HOST_PLATFORM === 'linux') {
      assert.match(ua, /Linux/);
      assert.doesNotMatch(ua, /Windows|Macintosh/);
    } else if (HOST_PLATFORM === 'windows') {
      assert.match(ua, /Windows/);
      assert.doesNotMatch(ua, /Linux|Macintosh/);
    } else {
      assert.match(ua, /Macintosh/);
      assert.doesNotMatch(ua, /Linux|Windows/);
    }

    const isWebdriver = await mainWorldEvaluate(page, () => navigator.webdriver, 'chromium');
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
    const ua = await mainWorldEvaluate(page, () => navigator.userAgent, 'chromium');
    assert.match(ua, /Android/);
    assert.match(ua, /Pixel 7/);
    assert.doesNotMatch(ua, /Windows/);
  } finally {
    await DriverBuilder.quit(context);
  }
});

test('build(): le masquage webgl.vendor (patchHardwareConcurrencyAndWebglVendor) s\'applique bien sur la page retournée', async () => {
  // Régression : l'onglet auto-ouvert par launchPersistentContext ne passe pas par
  // `context.newPage()`, donc les `addInitScript` enregistrés APRÈS (cf. `build()`) n'y
  // tournent pas.
  const builder = new DriverBuilder({
    baseProfileDir: makeTempProfileRoot(),
    headless: true,
    maxRetries: 1,
  });
  const { context, page } = await builder.build();
  try {
    // `mainWorldEvaluate` : le canvas/WebGL créés ici doivent utiliser les prototypes du monde
    // PRINCIPAL (où `patchHardwareConcurrencyAndWebglVendor` a patché `getParameter`), pas ceux
    // du monde isolé où `page.evaluate` tourne par défaut sous Patchright.
    const vendor = await mainWorldEvaluate(page, () => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') as WebGLRenderingContext | null;
      const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
      return dbg ? gl!.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null;
    }, 'chromium');
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
      const ua = await mainWorldEvaluate(page, () => navigator.userAgent, 'webkit');
      assert.match(ua, /iPhone/);
      assert.match(ua, /Safari/);
      assert.doesNotMatch(ua, /Chrome/);

      const isWebdriver = await mainWorldEvaluate(page, () => navigator.webdriver, 'webkit');
      assert.ok(isWebdriver === false || isWebdriver === undefined);

      // Un vrai Safari n'a jamais `window.chrome` : si ça apparaît, une évasion Chromium a
      // fuité vers WebKit.
      const hasChromeGlobal = await mainWorldEvaluate(page, () => 'chrome' in window, 'webkit');
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

// Découvert en testant un profil proxifié contre pixelscan.net/fingerprint-check : signalé
// "Timezone spoofed"/"Masking detected" parce que `timezoneId` vaut toujours 'Europe/Paris' par
// défaut, sans AUCUN rapport avec le pays de sortie réel du proxy — cf. doc de
// `resolveTimezoneFromProxy` dans driverBuilder.ts pour la détection auto (best-effort, via
// ip-api.com) censée corriger ça. Ces deux tests ne dépendent PAS d'un accès réseau réel à
// ip-api.com (injoignable depuis certains environnements sandboxés, constaté empiriquement) :
// ils vérifient seulement que l'échec de la détection ne casse jamais `build()` (repli sur la
// valeur par défaut), et qu'un `timezoneId` fourni explicitement n'est JAMAIS écrasé.

test('build() + proxy: un `timezoneId` explicite n\'est jamais écrasé par la détection auto', async () => {
  const builder = new DriverBuilder({
    baseProfileDir: makeTempProfileRoot(),
    headless: true,
    proxy: { server: 'http://127.0.0.1:1' }, // injoignable — la détection ne doit même pas être tentée
    timezoneId: 'Asia/Tokyo',
    maxRetries: 1,
  });
  const driver = await builder.build();
  try {
    const tz = await mainWorldEvaluate(driver.page, () => Intl.DateTimeFormat().resolvedOptions().timeZone, 'chromium');
    assert.equal(tz, 'Asia/Tokyo');
  } finally {
    await DriverBuilder.quit(driver.context);
  }
});

test('build() + proxy sans `timezoneId` explicite: une détection auto impossible retombe sur le défaut sans faire échouer build()', async () => {
  const builder = new DriverBuilder({
    baseProfileDir: makeTempProfileRoot(),
    headless: true,
    proxy: { server: 'http://127.0.0.1:1' }, // injoignable — la détection doit échouer silencieusement
    maxRetries: 1,
  });
  const driver = await builder.build();
  try {
    const tz = await mainWorldEvaluate(driver.page, () => Intl.DateTimeFormat().resolvedOptions().timeZone, 'chromium');
    assert.equal(tz, 'Europe/Paris');
  } finally {
    await DriverBuilder.quit(driver.context);
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
  return mainWorldEvaluate(page, () => {
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
  }, 'chromium');
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
    const [a, b] = await mainWorldEvaluate(driver.page, () => {
      const canvas = document.createElement('canvas');
      canvas.width = 50;
      canvas.height = 50;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#123456';
      ctx.fillRect(0, 0, 50, 50);
      const d1 = Array.from(ctx.getImageData(0, 0, 50, 50).data);
      const d2 = Array.from(ctx.getImageData(0, 0, 50, 50).data);
      return [d1, d2];
    }, 'chromium');
    assert.deepEqual(a, b, 'deux lectures du même canvas dans la même session doivent être identiques');
  } finally {
    await DriverBuilder.quit(driver.context);
  }
});

// --- Bruit WebGL (readPixels) déterministe par profil ------------------------------------

async function readWebglFingerprint(page: Page): Promise<number[]> {
  return mainWorldEvaluate(page, () => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const gl = canvas.getContext('webgl') as WebGLRenderingContext;
    gl.clearColor(0.4, 0.6, 0.8, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const pixels = new Uint8Array(32 * 32 * 4);
    gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return Array.from(pixels);
  }, 'chromium');
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
  return mainWorldEvaluate(page, async () => {
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
  }, 'chromium');
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
  return mainWorldEvaluate(page, () => {
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
  }, 'chromium');
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
    const info = await mainWorldEvaluate(driver.page, () => {
      const pc = new RTCPeerConnection();
      const channel = pc.createDataChannel('test');
      return { hasRTC: typeof RTCPeerConnection === 'function', channelLabel: channel.label };
    }, 'chromium');
    assert.equal(info.hasRTC, true);
    assert.equal(info.channelLabel, 'test');
  } finally {
    await DriverBuilder.quit(driver.context);
  }
});

// --- Défense fingerprint de polices --------------------------------------------------------

async function measureFont(page: Page, font: string, engine: 'chromium' | 'webkit'): Promise<number> {
  // `measureFont` prend un argument (`font`), donc n'utilise pas `mainWorldEvaluate` (réservé aux
  // fonctions sans argument), mais a besoin du même traitement — `applyFontFingerprintDefense`
  // patche le monde PRINCIPAL, pas le monde isolé où tourne `page.evaluate` par défaut côté
  // Chromium sous Patchright. `engine` : le 3e argument positionnel `isolatedContext` fait
  // PLANTER `webkit` (resté sur `playwright` classique, cf. doc de `mainWorldEvaluate`), donc
  // branche séparée pour ce moteur.
  const fn = (f: string) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = `72px ${f}, monospace`;
    return ctx.measureText('mmmmmmmmmmlli').width;
  };
  if (engine === 'webkit') {
    return page.evaluate(fn, font);
  }
  return page.evaluate(fn, font, undefined, false);
}

test("fingerprint de polices: sur un profil desktop, une police du système réellement détecté semble installée, pas une police d'un AUTRE système", async () => {
  // 'desktop' claim maintenant le vrai host (cf. `detectHostPlatformCategory`), donc la paire
  // "police attendue présente / police attendue absente" dépend de la machine qui fait tourner
  // ce test — jamais "Windows" supposé fixe. `Arial` n'est volontairement PAS utilisée comme
  // police "absente sur Linux" : cette distribution l'alias déjà métriquement vers Liberation
  // Sans (cf. `scripts/setup-fonts.sh`), donc elle semblerait installée sur les deux systèmes et
  // ne distinguerait rien.
  const [presentFont, absentFont] =
    HOST_PLATFORM === 'windows'
      ? ['Arial', 'DejaVu Sans']
      : HOST_PLATFORM === 'macos'
        ? ['Helvetica Neue', 'Segoe UI']
        : ['DejaVu Sans', 'Segoe UI'];

  const builder = new DriverBuilder({ baseProfileDir: makeTempProfileRoot(), headless: true, maxRetries: 1 });
  const driver = await builder.build();
  try {
    const baseline = await measureFont(driver.page, '__nonexistent_probe_font__', 'chromium');
    const present = await measureFont(driver.page, presentFont, 'chromium');
    const absent = await measureFont(driver.page, absentFont, 'chromium');

    assert.notEqual(present, baseline, `${presentFont} doit sembler installée sur un profil ${HOST_PLATFORM}`);
    assert.equal(absent, baseline, `${absentFont} ne doit pas sembler installée sur un profil ${HOST_PLATFORM}`);

    // Pas `mainWorldEvaluate` ici : son 4e argument positionnel (`isolatedContext: false`) laisse
    // la place à un 2e argument (`arg`), nécessaire pour passer `presentFont`/`absentFont` SANS
    // fermeture — une closure Node sur ces variables ne survivrait pas à la sérialisation de la
    // fonction vers la page (cf. doc de `measureFont`, même contrainte).
    const fontsCheckPresent = await driver.page.evaluate((f) => document.fonts.check(`72px ${f}`), presentFont, undefined, false);
    const fontsCheckAbsent = await driver.page.evaluate((f) => document.fonts.check(`72px ${f}`), absentFont, undefined, false);
    assert.equal(fontsCheckPresent, true);
    assert.equal(fontsCheckAbsent, false);
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
    const baseline = await measureFont(driver.page, '__nonexistent_probe_font__', 'chromium');
    const roboto = await measureFont(driver.page, 'Roboto', 'chromium');
    const segoeUi = await measureFont(driver.page, 'Segoe UI', 'chromium');

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
      const baseline = await measureFont(driver.page, '__nonexistent_probe_font__', 'webkit');
      const helveticaNeue = await measureFont(driver.page, 'Helvetica Neue', 'webkit');
      const menlo = await measureFont(driver.page, 'Menlo', 'webkit');
      const roboto = await measureFont(driver.page, 'Roboto', 'webkit');

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

// `navigator.platform` attendu par système host détectable (cf. `PLATFORM_STRINGS` dans
// driverBuilder.ts, non exporté — valeurs dupliquées ici intentionnellement, ce sont des chaînes
// stables du web platform, pas un détail d'implémentation interne).
const EXPECTED_PLATFORM_STRING: Record<'windows' | 'macos' | 'linux', string> = {
  windows: 'Win32',
  macos: 'MacIntel',
  linux: 'Linux x86_64',
};

test('navigator.platform/languages: profil desktop — cohérents avec le vrai host détecté et la locale configurée', async () => {
  const builder = new DriverBuilder({
    baseProfileDir: makeTempProfileRoot(),
    headless: true,
    locale: 'de-DE',
    maxRetries: 1,
  });
  const driver = await builder.build();
  try {
    const info = await mainWorldEvaluate(
      driver.page,
      () => ({
        platform: navigator.platform,
        language: navigator.language,
        languages: navigator.languages,
      }),
      'chromium'
    );
    assert.equal(info.platform, EXPECTED_PLATFORM_STRING[HOST_PLATFORM]);
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
    const platform = await mainWorldEvaluate(driver.page, () => navigator.platform, 'chromium');
    assert.equal(platform, 'Linux armv8l');
  } finally {
    await DriverBuilder.quit(driver.context);
  }
});

// --- Client Hints (navigator.userAgentData) -------------------------------------------------
// `getHighEntropyValues()` révélait littéralement la marque "HeadlessChrome" (constaté via
// CreepJS) — nécessite un contexte sécurisé (HTTPS), d'où la navigation vers une vraie page.

// `userAgentData.platform` attendu par système host détectable (cf. `CLIENT_HINTS_BY_PLATFORM`
// dans driverBuilder.ts — valeurs Client Hints standard, pas un détail d'implémentation interne).
const EXPECTED_UA_DATA_PLATFORM: Record<'windows' | 'macos' | 'linux', string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
};

test('Client Hints: ne révèlent pas "Headless", cohérents avec la plateforme et la version de navigator.userAgent', async () => {
  const builder = new DriverBuilder({ baseProfileDir: makeTempProfileRoot(), headless: true, maxRetries: 1 });
  const driver = await builder.build();
  try {
    await driver.page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const info = await mainWorldEvaluate(driver.page, async () => {
      if (!('userAgentData' in navigator)) return null;
      const hev = await (navigator as any).userAgentData.getHighEntropyValues(['platform', 'uaFullVersion']);
      return { brands: (navigator as any).userAgentData.brands, platform: (navigator as any).userAgentData.platform, hev };
    }, 'chromium');
    assert.ok(info, 'navigator.userAgentData doit exister sur un contexte sécurisé (Chromium)');
    const brandNames = info!.brands.map((b: { brand: string }) => b.brand).join(',');
    assert.doesNotMatch(brandNames, /Headless/i);
    assert.equal(info!.platform, EXPECTED_UA_DATA_PLATFORM[HOST_PLATFORM]);
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
    const [main, worker] = await mainWorldEvaluate(driver.page, () => {
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
    }, 'chromium');
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
    await mainWorldEvaluate(driver.page, async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
          setTimeout(resolve, 5000);
        });
      }
    }, 'chromium');

    const hasController = await mainWorldEvaluate(driver.page, () => !!navigator.serviceWorker.controller, 'chromium');
    assert.ok(hasController, 'le Service Worker doit avoir pris le contrôle de la page (clients.claim())');

    const main = await mainWorldEvaluate(driver.page, async () => {
      let userAgentData = null;
      if ('userAgentData' in navigator) {
        const hev = await (navigator as any).userAgentData.getHighEntropyValues(['platform', 'uaFullVersion']);
        userAgentData = { brands: (navigator as any).userAgentData.brands, platform: (navigator as any).userAgentData.platform, hev };
      }
      return { ua: navigator.userAgent, platform: navigator.platform, cores: navigator.hardwareConcurrency, userAgentData };
    }, 'chromium');
    const sw = await mainWorldEvaluate(driver.page, () => {
      return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (e) => resolve(e.data);
        navigator.serviceWorker.controller!.postMessage({ cmd: 'fingerprint' }, [channel.port2]);
        setTimeout(() => resolve({ timeout: true }), 5000);
      });
    }, 'chromium');

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

// Régression (2026-10-26) : une page YouTube réelle restait blanche (vidéo/audio natifs jouaient,
// mais aucune UI ne s'affichait) à cause de `patchServiceWorkerFingerprint` qui préfixait du JS
// devant TOUTE ressource récupérée par le Service Worker, pas seulement son propre script — un
// Service Worker de production (précaching type Workbox) fait aussi des `fetch()` internes pour du
// CSS/JSON/images, que `request.serviceWorker()` non-null ne distingue pas de son script JS. Ce
// test verrouille que seule une réponse réellement JavaScript (Content-Type) est réécrite ; une
// ressource non-JS récupérée PAR le Service Worker doit ressortir strictement inchangée.
test('fingerprint des Service Workers: une ressource NON-JS récupérée par le Service Worker (ex. JSON de précaching) n\'est jamais réécrite', async () => {
  const JSON_BODY = JSON.stringify({ hello: 'world', cached: true });
  const swServer = http.createServer((req, res) => {
    if (req.url === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(`
        self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
        self.addEventListener('message', async (e) => {
          const r = await fetch('/data.json');
          const text = await r.text();
          e.ports[0].postMessage({ text });
        });
      `);
    } else if (req.url === '/data.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON_BODY);
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
    await mainWorldEvaluate(driver.page, async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
          setTimeout(resolve, 5000);
        });
      }
    }, 'chromium');

    const result = await mainWorldEvaluate(driver.page, () => {
      return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (e) => resolve(e.data);
        navigator.serviceWorker.controller!.postMessage({ cmd: 'fetch-json' }, [channel.port2]);
        setTimeout(() => resolve({ timeout: true }), 5000);
      });
    }, 'chromium');

    assert.equal(
      (result as any).text,
      JSON_BODY,
      'une ressource JSON récupérée par le Service Worker doit ressortir identique, jamais préfixée de JS'
    );
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
// `applyClientHintsCdpOverride`/`patchServiceWorkerFingerprint` dans driverBuilder.ts.

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

// Découvert en testant une vraie tentative de connexion sur x.com : ce site redirige (302) sa
// page de login vers un endpoint de vérification anti-bot avant d'afficher le formulaire — et
// CET endpoint, atteint uniquement via la redirection, recevait encore "HeadlessChrome" dans
// Sec-CH-UA malgré le correctif ci-dessus, qui ne couvre qu'une navigation SANS redirection. cf.
// doc d'`applyClientHintsCdpOverride` dans driverBuilder.ts pour les techniques essayées et
// écartées (dont une qui corrigeait l'en-tête mais cassait l'empreinte TLS/JA3).
test('en-tête HTTP Sec-CH-UA: survit à une redirection HTTP (cas x.com)', async () => {
  let capturedHeaders: http.IncomingHttpHeaders | null = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/target' });
      res.end();
      return;
    }
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
    await driver.page.goto(`http://127.0.0.1:${address.port}/start`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    assert.match(driver.page.url(), /\/target$/, 'la page doit bien suivre la redirection jusqu\'à /target');
    assert.ok(capturedHeaders, 'le serveur local doit avoir reçu la requête redirigée');
    const secChUa = capturedHeaders!['sec-ch-ua'];
    assert.ok(secChUa, 'Sec-CH-UA doit être envoyé par défaut par Chromium');
    assert.doesNotMatch(secChUa as string, /Headless/i);
    assert.match(secChUa as string, /Google Chrome/);
  } finally {
    await DriverBuilder.quit(driver.context);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Découvert à l'oeil nu en utilisant un profil manuellement (chrome://version) : sans
// `channel: 'chrome'` dans `build()`, Playwright lance son propre Chromium embarqué, qui
// s'identifie littéralement "Google Chrome for Testing" — un build distribué par Google pour
// l'automatisation/CI, jamais pour un usage humain, avec des composants retirés (Widevine/DRM
// notamment — a fait planter la lecture YouTube). Visible à l'oeil sur `chrome://version`, et
// potentiellement par des services Google eux-mêmes (reCAPTCHA plus agressif constaté sur la
// même session, sur le même profil).
test('build(): lance le VRAI Google Chrome, jamais le build "for Testing" embarqué par Playwright', async () => {
  const builder = new DriverBuilder({ baseProfileDir: makeTempProfileRoot(), headless: true, maxRetries: 1 });
  const driver = await builder.build();
  try {
    await driver.page.goto('chrome://version', { timeout: 15000 });
    const text = await mainWorldEvaluate(driver.page, () => document.body.innerText, 'chromium');
    assert.match(text, /Google Chrome\t/, 'doit afficher "Google Chrome", pas une variante');
    assert.doesNotMatch(text, /for Testing/i);
  } finally {
    await DriverBuilder.quit(driver.context);
  }
});

// Découvert en utilisant un profil 'desktop' à la main : redimensionner la fenêtre ne changeait
// RIEN à ce que la page voit (viewport figé par l'émulation CDP de Playwright, indépendante de
// la vraie fenêtre) — un vrai navigateur, lui, suit toujours sa fenêtre réelle. cf. doc de
// `pickDeviceConfig` (`viewport: null` + `--window-size`).
test('build(): le viewport d\'un profil desktop suit un vrai redimensionnement de fenêtre (pas figé par Playwright)', async () => {
  const builder = new DriverBuilder({ baseProfileDir: makeTempProfileRoot(), headless: true, maxRetries: 1 });
  const driver = await builder.build();
  try {
    await driver.page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const before = await mainWorldEvaluate(driver.page, () => ({ w: window.innerWidth, h: window.innerHeight }), 'chromium');

    const cdp = await driver.context.newCDPSession(driver.page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 900, height: 600 } });
    await driver.page.waitForTimeout(500);

    const after = await mainWorldEvaluate(driver.page, () => ({ w: window.innerWidth, h: window.innerHeight }), 'chromium');
    assert.notDeepEqual(after, before, 'le viewport doit changer suite au redimensionnement de la fenêtre');
  } finally {
    await DriverBuilder.quit(driver.context);
  }
});
