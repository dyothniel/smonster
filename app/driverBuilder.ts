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

type Engine = 'chromium' | 'webkit';

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
}

export interface DriverBuilderOptions {
  baseProfileDir?: string;
  headless?: boolean;
  proxy?: ProxyConfig;
  keepProfile?: boolean;
  maxRetries?: number;
  device?: keyof typeof playwrightDevices | 'desktop';
  locale?: string;
  timezoneId?: string;
}

export interface BuiltDriver {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  profileDir: string;
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
  private headless: boolean;
  private proxy?: ProxyConfig;
  private keepProfile: boolean;
  private maxRetries: number;
  private device: NonNullable<DriverBuilderOptions['device']>;
  private locale: string;
  private timezoneId: string;

  constructor(opts: DriverBuilderOptions = {}) {
    this.baseProfileDir = opts.baseProfileDir ?? path.join(os.tmpdir(), 'browser-profiles');
    this.headless = opts.headless ?? false;
    this.proxy = opts.proxy;
    this.keepProfile = opts.keepProfile ?? false;
    this.maxRetries = opts.maxRetries ?? 3;
    this.device = opts.device ?? 'desktop';
    this.locale = opts.locale ?? 'fr-FR';
    this.timezoneId = opts.timezoneId ?? 'Europe/Paris';

    fs.mkdirSync(this.baseProfileDir, { recursive: true });
  }

  private newProfileDir(): string {
    const sessionId = randomUUID().slice(0, 12);
    const dir = path.join(this.baseProfileDir, `profile-${sessionId}`);
    fs.mkdirSync(dir, { recursive: false });
    return dir;
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
      const profileDir = this.newProfileDir();
      try {
        const { engine, ...deviceConfig } = await this.pickDeviceConfig();
        const launcher = engine === 'webkit' ? webkit : chromium;

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
        const context = await launcher.launchPersistentContext(profileDir, {
          headless: this.headless,
          locale: this.locale,
          timezoneId: this.timezoneId,
          ...(this.proxy ? { proxy: this.proxy } : {}),
          ...deviceConfig,
          ...engineArgs,
        });

        if (engine === 'webkit') {
          // Partie JS de l'évasion `navigator.webdriver` du plugin stealth, appliquée à la
          // main : on évite sa partie `beforeLaunch` (flag CLI Chromium, cf. commentaire plus
          // haut) mais on garde le nettoyage de la propriété si jamais WebKit l'expose.
          await context.addInitScript(() => {
            const proto = Object.getPrototypeOf(navigator);
            if (proto.webdriver === true) {
              delete proto.webdriver;
            }
          });
        }

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

        if (!this.keepProfile) {
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
        };
      } catch (err) {
        lastErr = err;
        console.warn(`Échec tentative ${attempt}/${this.maxRetries}:`, err);
        fs.rmSync(profileDir, { recursive: true, force: true });
        await this.sleep(1500 * attempt);
      }
    }

    throw new Error(`Impossible de créer un driver sain après ${this.maxRetries} tentatives: ${lastErr}`);
  }

  private async healthCheck(page: Page): Promise<void> {
    await page.goto('about:blank');
    const isWebdriver = await page.evaluate(() => navigator.webdriver);
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