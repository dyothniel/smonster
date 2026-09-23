import { chromium, webkit } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
// `devices` est importé depuis `playwright` (et non `playwright-extra`) : playwright-extra
// se contente de relayer le même objet au runtime, mais son .d.ts le type comme une
// intersection avec un tableau, ce qui pollue `keyof typeof devices` avec `symbol` et fait
// planter le typage de `device` plus bas (TS2731 sur le template literal).
import { devices as playwrightDevices } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { ProxyRotator } from './proxyRotator';

type Engine = 'chromium' | 'webkit';

/**
 * Dérive un seed 32 bits stable à partir d'une chaîne (ici, `profileDir`). Même profil (même
 * dossier, y compris relancé plus tard) → même seed → même bruit de canvas ; profil différent →
 * seed différente. Simple hash déterministe (djb2-like), pas besoin de cryptographique ici.
 */
export function hashToSeed(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/**
 * Ajoute un bruit imperceptible mais déterministe (fonction de `seed` et de la position du
 * pixel, jamais d'un compteur d'appel) aux lectures de canvas 2D (`getImageData`, `toDataURL`,
 * `toBlob`) : deux profils avec le même device/proxy/timezone ressortent quand même avec un
 * fingerprint canvas différent, alors qu'un même profil relancé plusieurs fois garde TOUJOURS le
 * même fingerprint — un vrai utilisateur a un rendu canvas stable dans le temps sur sa machine ;
 * un bruit qui changerait à chaque appel serait lui-même un signal de détection.
 *
 * Fonction top-level pure (aucune closure sur des variables Node) : son code source est
 * sérialisé tel quel par Playwright pour tourner dans la page via `context.addInitScript`.
 */
function applyCanvasNoise(seed: number): void {
  function pixelNoise(index: number): number {
    let h = (seed ^ index) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = (h ^ (h >>> 16)) >>> 0;
    return (h % 3) - 1; // -1, 0 ou 1
  }
  function clamp(v: number): number {
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }
  function noiseImageData(imageData: ImageData): ImageData {
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = clamp(data[i] + pixelNoise(i));
      data[i + 1] = clamp(data[i + 1] + pixelNoise(i + 1));
      data[i + 2] = clamp(data[i + 2] + pixelNoise(i + 2));
      // canal alpha (i + 3) intact : le bruit ne doit toucher que la couleur.
    }
    return imageData;
  }

  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (
    this: CanvasRenderingContext2D,
    ...args: Parameters<typeof origGetImageData>
  ) {
    return noiseImageData(origGetImageData.apply(this, args));
  };

  // `toDataURL`/`toBlob` ne passent pas forcément par `getImageData` en interne : on les fait
  // exporter depuis un clone bruité plutôt que le canvas d'origine, pour rester cohérent avec ce
  // que `getImageData` renverrait sur ce même contenu.
  function noisyClone(canvas: HTMLCanvasElement): HTMLCanvasElement {
    const clone = document.createElement('canvas');
    clone.width = canvas.width;
    clone.height = canvas.height;
    const ctx = clone.getContext('2d')!;
    ctx.drawImage(canvas, 0, 0);
    const imageData = noiseImageData(origGetImageData.call(ctx, 0, 0, clone.width, clone.height));
    ctx.putImageData(imageData, 0, 0);
    return clone;
  }

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (this: HTMLCanvasElement, ...args: unknown[]) {
    return (origToDataURL as (...a: unknown[]) => string).apply(noisyClone(this), args);
  };

  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, ...args: unknown[]) {
    return (origToBlob as (...a: unknown[]) => void).apply(noisyClone(this), args);
  };
}

/**
 * Détermine le moteur (`chromium` ou `webkit`) à utiliser pour un `device` donné, sans rien
 * lancer. Extrait de `pickDeviceConfig` en fonction pure et exportée pour pouvoir tester le
 * routing iOS/Android/desktop sans dépendre d'un binaire de navigateur installé.
 *
 * `defaultBrowserType` indique le moteur pour lequel Playwright a calibré ce device (UA,
 * viewport, touch...). Un preset iOS ('iPhone 15', 'iPad Mini', 'Desktop Safari'...) vaut
 * 'webkit' ; un preset Android ('Pixel 7'...) vaut 'chromium'. On respecte ce choix plutôt que
 * de tout lancer sous Chromium : sinon les client hints (Sec-CH-UA, Chromium par construction)
 * resteraient incohérents avec un UA/touch/viewport qui mime un Safari/WebKit.
 */
export function resolveEngineForDevice(device: NonNullable<DriverBuilderOptions['device']>): Engine {
  if (device === 'desktop') {
    return 'chromium';
  }
  const preset = playwrightDevices[device];
  if (!preset) {
    throw new Error(`Device inconnu: ${String(device)}. Voir playwright.devices pour la liste.`);
  }
  if (preset.defaultBrowserType === 'firefox') {
    throw new Error(
      `Device '${String(device)}' cible Firefox (defaultBrowserType: 'firefox'), non géré par ` +
        `ce DriverBuilder (seuls chromium et webkit sont supportés).`
    );
  }
  return preset.defaultBrowserType;
}

// `user-agent-override` est exclue même côté Chromium (elle est activée par défaut dans le
// jeu complet du plugin) : elle recalcule sa propre valeur à partir de l'UA brut du
// navigateur (avec un masquage Linux -> Windows) sans connaître l'UA explicite que
// `pickDeviceConfig` fixe déjà pour chaque device (ex. Android), et l'écrase donc via son
// override CDP. Vérifié empiriquement : avec cette évasion active, un device 'Pixel 7'
// ressortait avec un UA desktop Windows au lieu de l'UA Android attendu. Playwright gère déjà
// nativement l'UA (et l'en-tête HTTP associé) via l'option de contexte `userAgent` qu'on
// passe nous-mêmes — pas besoin de cette évasion pour ça.
const CHROMIUM_STEALTH_EVASIONS = new Set(
  [...stealth().availableEvasions].filter((e) => e !== 'user-agent-override')
);
chromium.use(stealth({ enabledEvasions: CHROMIUM_STEALTH_EVASIONS }));

// `puppeteer-extra-plugin-stealth` a été écrit pour faire passer un Chromium headless pour
// un Chromium standard : plusieurs de ses évasions injectent ou imitent des artefacts propres
// à Chrome. Les appliquer telles quelles sur WebKit (utilisé ici pour les presets iOS/Safari,
// voir `pickDeviceConfig`) serait contre-productif — un vrai Safari n'a jamais ces artefacts,
// donc les ajouter crée un signal de détection au lieu d'en effacer un :
//   - chrome.app / chrome.csi / chrome.loadTimes / chrome.runtime injectent un objet
//     `window.chrome`, inexistant sur Safari.
//   - navigator.plugins mock la liste de plugins de Chrome (Chrome PDF Plugin, Native
//     Client...), absente sur Safari.
//   - iframe.contentWindow corrige un bug spécifique au moteur Blink.
//   - defaultArgs nettoie des flags de lancement propres à Chromium.
//   - sourceurl / user-agent-override pilotent Chrome DevTools Protocol (CDP). WebKit ne
//     parle pas CDP : playwright-extra leur renvoie un client CDP factice (no-op), donc pas
//     de crash, mais pas d'effet non plus — autant ne pas les charger. Le cas de
//     user-agent-override est de toute façon couvert nativement par l'option `userAgent` du
//     device Playwright passée à `launchPersistentContext`.
// On ne garde donc que les évasions génériques, qui patchent des propriétés JS standard
// (navigator.*, WebGL, dimensions de fenêtre) sans halluciner d'API propre à Chrome.
// `navigator.webdriver` est traité à part (cf. `build()`) : la version packagée pousse un
// flag de lancement Chromium (--disable-blink-features=AutomationControlled) qu'on ne veut
// pas envoyer à WebKit, dont le comportement avec ce flag n'est pas garanti.
const GENERIC_STEALTH_EVASIONS = new Set([
  'navigator.languages',
  'navigator.hardwareConcurrency',
  'navigator.permissions',
  'webgl.vendor',
  'media.codecs',
  'window.outerdimensions',
]);
webkit.use(stealth({ enabledEvasions: GENERIC_STEALTH_EVASIONS }));

export interface ProxyConfig {
  server: string;
  bypass?: string;
  username?: string;
  password?: string;
  /**
   * URL de rotation optionnelle proposée par certains fournisseurs de proxy résidentiels/
   * rotatifs : appeler cette URL déclenche un changement d'IP de sortie côté fournisseur, sans
   * changer `server`. Purement informatif pour l'instant — DriverBuilder ne l'appelle jamais
   * lui-même (aucun appel HTTP automatique), c'est juste transporté avec le reste de la config
   * pour que l'appelant puisse s'en servir (bouton manuel, appel avant lancement, etc.) s'il le
   * souhaite.
   */
  rotationUrl?: string;
}

export interface DriverBuilderOptions {
  baseProfileDir?: string;
  headless?: boolean;
  /** Proxy fixe pour toutes les tentatives. Mutuellement exclusif avec `proxyRotator`. */
  proxy?: ProxyConfig;
  /**
   * Source de proxies avec rotation/exclusion (cf. proxyRotator.ts). À chaque tentative de
   * `build()`, un proxy est demandé via `proxyRotator.next(proxyStickyKey)` ; un échec de
   * cette tentative est rapporté au rotator avant de retenter avec un autre proxy. Mutuellement
   * exclusif avec `proxy`.
   */
  proxyRotator?: ProxyRotator;
  /**
   * Clé de stickiness transmise à `proxyRotator.next()` : deux `DriverBuilder` avec la même
   * clé se voient assigner le même proxy tant qu'il reste disponible (utile pour garder une IP
   * stable sur un slot de `DriverPool` malgré le recyclage des profils). Ignoré sans
   * `proxyRotator`.
   */
  proxyStickyKey?: string;
  keepProfile?: boolean;
  maxRetries?: number;
  device?: keyof typeof playwrightDevices | 'desktop';
  locale?: string;
  timezoneId?: string;
  /**
   * Chemin fixe pour un profil nommé et persistant (ex. géré par un `ProfileManager`), à la
   * place d'un dossier éphémère généré aléatoirement sous `baseProfileDir`. Si fourni, ce
   * dossier n'est JAMAIS supprimé automatiquement — ni par le nettoyage sur échec de tentative
   * dans `build()`, ni par `quit()` — quelle que soit la valeur de `keepProfile` : les
   * cookies/données d'un profil nommé doivent survivre à un simple hoquet de lancement ou à une
   * fermeture normale. C'est à l'appelant de le supprimer explicitement s'il veut s'en défaire.
   */
  profileDir?: string;
}

export interface BuiltDriver {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  profileDir: string;
  /**
   * Le proxy effectivement utilisé pour ce driver (statique ou pioché via `proxyRotator`),
   * `undefined` si aucun. Exposé pour que l'appelant puisse rapporter un échec au rotator
   * après coup : `healthCheck()` ne navigue que vers `about:blank` (jamais proxifié), donc un
   * proxy injoignable ou mal configuré n'est PAS détecté par `build()` lui-même — vérifié
   * empiriquement, Chromium démarre sans broncher avec un `proxy.server` invalide. C'est à
   * l'appelant, s'il constate l'échec (ex. un `page.goto()` réel qui time out), de faire
   * `proxyRotator.reportFailure(driver.proxy)`.
   */
  proxy?: ProxyConfig;
}

// Associe chaque contexte persistant au dossier de profil à supprimer dans quit(),
// sans polluer l'objet BrowserContext avec une propriété non typée.
const profileDirsToClean = new WeakMap<BrowserContext, string>();

const DESKTOP_VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
];

// Utilisée uniquement pour le fallback 'desktop' en headless (cf. `pickDeviceConfig`) : sans
// UA explicite, Chromium headless annonce littéralement `HeadlessChrome/…` (et son hôte Linux)
// dans l'UA — un signal évident. On ne peut plus compter sur l'évasion `user-agent-override`
// du plugin stealth pour nettoyer ça (cf. commentaire sur `CHROMIUM_STEALTH_EVASIONS`), donc on
// construit nous-mêmes un UA desktop plausible (masqué en Windows, comme le ferait cette
// évasion), avec la vraie version de Chromium embarqué pour rester cohérent avec les client
// hints. Un seul lancement/fermeture de navigateur, mis en cache pour tout le process.
let cachedHeadlessDesktopUserAgent: Promise<string> | null = null;
async function getHeadlessDesktopUserAgent(): Promise<string> {
  if (!cachedHeadlessDesktopUserAgent) {
    cachedHeadlessDesktopUserAgent = (async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const version = await browser.version();
        return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
      } finally {
        await browser.close();
      }
    })();
  }
  return cachedHeadlessDesktopUserAgent;
}

export class DriverBuilder {
  private baseProfileDir: string;
  private fixedProfileDir?: string;
  private headless: boolean;
  private proxy?: ProxyConfig;
  private proxyRotator?: ProxyRotator;
  private proxyStickyKey?: string;
  private keepProfile: boolean;
  private maxRetries: number;
  private device: NonNullable<DriverBuilderOptions['device']>;
  private locale: string;
  private timezoneId: string;

  constructor(opts: DriverBuilderOptions = {}) {
    if (opts.proxy && opts.proxyRotator) {
      throw new Error('DriverBuilderOptions: `proxy` et `proxyRotator` sont mutuellement exclusifs.');
    }
    this.fixedProfileDir = opts.profileDir;
    this.baseProfileDir = opts.baseProfileDir ?? path.join(os.tmpdir(), 'browser-profiles');
    this.headless = opts.headless ?? false;
    this.proxy = opts.proxy;
    this.proxyRotator = opts.proxyRotator;
    this.proxyStickyKey = opts.proxyStickyKey;
    this.keepProfile = opts.keepProfile ?? false;
    this.maxRetries = opts.maxRetries ?? 3;
    this.device = opts.device ?? 'desktop';
    this.locale = opts.locale ?? 'fr-FR';
    this.timezoneId = opts.timezoneId ?? 'Europe/Paris';

    // Inutile de préparer un dossier de base éphémère si on ne s'en servira jamais (chemin
    // fixe fourni).
    if (!this.fixedProfileDir) {
      fs.mkdirSync(this.baseProfileDir, { recursive: true });
    }
  }

  /**
   * Résout le dossier de profil à utiliser pour une tentative de `build()`. `ephemeral: false`
   * signifie « ne jamais supprimer ce dossier automatiquement » (cf. doc de `profileDir` sur
   * `DriverBuilderOptions`) : c'est ce flag qui protège un profil nommé persistant du nettoyage
   * sur échec de tentative et du nettoyage dans `quit()`.
   */
  private resolveProfileDir(): { dir: string; ephemeral: boolean } {
    if (this.fixedProfileDir) {
      fs.mkdirSync(this.fixedProfileDir, { recursive: true });
      return { dir: this.fixedProfileDir, ephemeral: false };
    }
    const sessionId = randomUUID().slice(0, 12);
    const dir = path.join(this.baseProfileDir, `profile-${sessionId}`);
    fs.mkdirSync(dir, { recursive: false });
    return { dir, ephemeral: true };
  }

  private async pickDeviceConfig() {
    const engine = resolveEngineForDevice(this.device);
    if (this.device === 'desktop') {
      const viewport = DESKTOP_VIEWPORTS[Math.floor(Math.random() * DESKTOP_VIEWPORTS.length)];
      const userAgent = this.headless ? await getHeadlessDesktopUserAgent() : undefined;
      return {
        engine,
        viewport,
        isMobile: false,
        hasTouch: false,
        ...(userAgent ? { userAgent } : {}),
      };
    }
    // `resolveEngineForDevice` a déjà validé que ce device existe et n'est pas un preset
    // Firefox, donc `preset` est forcément défini ici.
    const { defaultBrowserType, ...deviceConfig } = playwrightDevices[this.device];
    return { engine, ...deviceConfig };
  }

  private sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }

  async build(): Promise<BuiltDriver> {
    let lastErr: unknown;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const { dir: profileDir, ephemeral } = this.resolveProfileDir();
      // Déclarés ici (et pas juste résolus/créés inline plus bas) pour que le `catch` puisse y
      // accéder : `proxy`, pour rapporter l'échec au rotator (reste `undefined` si l'erreur
      // survient avant sa résolution, ex. un device inconnu — pas question d'incriminer un proxy
      // pour une erreur qui lui est étrangère) ; `context`, pour le fermer si le lancement a
      // réussi mais qu'une étape *suivante* (healthCheck...) a échoué — sinon ce navigateur déjà
      // lancé fuit indéfiniment (process orphelin), qu'on retente ensuite ou qu'on abandonne.
      let proxy: ProxyConfig | undefined;
      let context: BrowserContext | undefined;
      try {
        const { engine, ...deviceConfig } = await this.pickDeviceConfig();
        const launcher = engine === 'webkit' ? webkit : chromium;
        proxy = this.proxyRotator ? this.proxyRotator.next(this.proxyStickyKey) : this.proxy;

        // Les flags `--no-sandbox` / `--disable-blink-features=...` sont spécifiques à
        // Chromium (sandboxing et flags Blink) : inutiles sur WebKit, et leur effet sur ce
        // moteur n'est pas garanti, donc on ne les envoie que pour Chromium.
        const engineArgs =
          engine === 'chromium'
            ? {
                args: [
                  '--no-sandbox',
                  '--disable-dev-shm-usage',
                  '--disable-blink-features=AutomationControlled',
                  '--no-first-run',
                  '--no-default-browser-check',
                  `--lang=${this.locale}`,
                ],
              }
            : {};

        // launchPersistentContext = profil isolé sur disque, comme --user-data-dir
        context = await launcher.launchPersistentContext(profileDir, {
          headless: this.headless,
          locale: this.locale,
          timezoneId: this.timezoneId,
          ...(proxy ? { proxy } : {}),
          ...deviceConfig,
          ...engineArgs,
        });

        // Bruit de canvas déterministe par profil (cf. doc de `applyCanvasNoise`) : seedé sur
        // `profileDir`, donc stable pour CE profil (même fingerprint à chaque relance d'un
        // profil nommé) mais différent d'un profil à l'autre, même device/proxy/timezone
        // identiques. S'applique aux deux moteurs, avant même la création de la page.
        await context.addInitScript(applyCanvasNoise, hashToSeed(profileDir));

        // Pas de `context.addInitScript(hideWebdriver)` ici pour webkit, volontairement : vérifié
        // empiriquement sur webkit-2359 (build de repli non officiel pour cette distribution),
        // supprimer `navigator.webdriver` UNE DEUXIÈME fois (une fois via un script d'init, une
        // fois via l'évaluation directe de `healthCheck`) corrompt le getter natif — un accès
        // suivant lève `TypeError: The Navigator.webdriver getter can only be used on instances
        // of Navigator`, reproductible aussi bien sur un device mobile (iPhone) que desktop
        // (Desktop Safari). Une seule tentative de suppression, faite dans `healthCheck` juste
        // avant la lecture, est fiable ; en faire une deuxième ne l'est pas.

        // On force le passage par `context.newPage()` plutôt que de réutiliser l'onglet
        // vierge auto-ouvert par certains moteurs (Chromium) sur `launchPersistentContext` :
        // vérifié empiriquement, cet onglet auto-ouvert ne passe pas par le hook
        // `onPageCreated` de playwright-extra, donc TOUTES les évasions au niveau page du
        // plugin stealth (webgl.vendor, navigator.plugins/languages/permissions,
        // media.codecs, chrome.*...) restent muettes dessus alors qu'elles s'appliquent
        // normalement sur un onglet créé via `newPage()`. On ferme ensuite les onglets
        // vierges superflus.
        const staleInitialPages = context.pages();
        const page = await context.newPage();
        await Promise.all(staleInitialPages.map((p) => p.close()));

        // Jitter humain avant la première action
        await this.sleep(400 + Math.random() * 800);

        await this.healthCheck(page);

        if (this.proxyRotator && proxy) {
          this.proxyRotator.reportSuccess(proxy);
        }

        if (ephemeral && !this.keepProfile) {
          profileDirsToClean.set(context, profileDir);
        }

        const browser = context.browser();
        if (!browser) {
          throw new Error('Aucun Browser associé au contexte persistant (inattendu hors Android/Electron).');
        }

        return {
          browser,
          context,
          page,
          profileDir,
          proxy,
        };
      } catch (err) {
        lastErr = err;
        if (this.proxyRotator && proxy) {
          this.proxyRotator.reportFailure(proxy);
        }
        console.warn(`Échec tentative ${attempt}/${this.maxRetries}:`, err);
        // Le lancement a pu réussir alors qu'une étape suivante (healthCheck...) a échoué : sans
        // ça, ce navigateur déjà démarré fuit indéfiniment (process orphelin) à chaque tentative
        // ratée. `.catch()` ici : `close()` peut lui-même échouer (process déjà mort...), ça ne
        // doit jamais empêcher de continuer vers la tentative suivante.
        if (context) {
          await context.close().catch(() => {});
        }
        // Un dossier éphémère raté est sans contenu utile : safe à nuker avant de retenter. Un
        // profil à chemin fixe peut déjà contenir de vraies données (cookies/localStorage d'un
        // lancement précédent) : un hoquet de lancement ne doit jamais les effacer.
        if (ephemeral) {
          fs.rmSync(profileDir, { recursive: true, force: true });
        }
        await this.sleep(1500 * attempt);
      }
    }

    throw new Error(`Impossible de créer un driver sain après ${this.maxRetries} tentatives: ${lastErr}`);
  }

  private async healthCheck(page: Page): Promise<void> {
    await page.goto('about:blank');
    // Une navigation vers `about:blank` ne redéclenche pas de façon fiable les scripts d'init
    // enregistrés au niveau du contexte sur certains moteurs/versions, donc `navigator.webdriver`
    // doit être neutralisé ici, directement dans le document courant.
    //
    // Cause racine d'un bug qu'on a mis du temps à cerner : lire OU écrire cette propriété via
    // `Object.getPrototypeOf(navigator).webdriver` invoque le getter natif avec `this` lié au
    // PROTOTYPE (`Navigator.prototype`) et non à l'instance `navigator` — un receiver invalide.
    // Sur des getters avec vérification de type stricte, ça lève `TypeError: Illegal invocation`
    // (Chromium) ou `... can only be used on instances of Navigator` (WebKit, notamment le build
    // de repli non officiel pour cette distribution — cf. l'avertissement « your OS is not
    // officially supported » de Playwright à l'installation). Solution : ne JAMAIS invoquer ce
    // getter via `proto`, seulement via `navigator` (le bon receiver) — pour la LECTURE comme
    // pour le TEST qui décide s'il faut redéfinir la propriété. Une fois redéfinie avec un getter
    // neutre (`() => false`, qui ignore `this`), plus aucun risque de ce côté-là.
    let isWebdriver: unknown;
    try {
      isWebdriver = await page.evaluate(() => {
        if (navigator.webdriver === true) {
          Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', {
            get: () => false,
            configurable: true,
            enumerable: true,
          });
        }
        return navigator.webdriver;
      });
    } catch (err) {
      throw new Error(
        `Impossible de vérifier/neutraliser navigator.webdriver — profil non furtif : ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    if (isWebdriver) {
      throw new Error('navigator.webdriver détecté à true — profil non furtif');
    }
  }

  static async quit(context: BrowserContext): Promise<void> {
    const profileDir = profileDirsToClean.get(context);
    try {
      await context.close();
    } finally {
      if (profileDir) {
        fs.rmSync(profileDir, { recursive: true, force: true });
      }
    }
  }
}