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
 * Ajoute un bruit imperceptible mais déterministe (fonction de `seed` et de la position de
 * l'échantillon, jamais d'un compteur d'appel) sur les trois vecteurs de fingerprinting les
 * plus courants basés sur des lectures de pixels/échantillons :
 *   - canvas 2D : `getImageData`, `toDataURL`, `toBlob`.
 *   - WebGL : `readPixels` en direct (en plus, `toDataURL`/`toBlob` sur un canvas WebGL passent
 *     déjà par le chemin canvas 2D ci-dessus via `drawImage`, donc bruités par la même logique).
 *   - Audio : `AudioBuffer.getChannelData`, la technique la plus répandue de fingerprint audio
 *     (rendu via `OfflineAudioContext` puis lecture des échantillons).
 *
 * Deux profils avec le même device/proxy/timezone ressortent quand même avec des fingerprints
 * différents sur ces trois axes, alors qu'un même profil relancé plusieurs fois garde TOUJOURS
 * le même résultat — un vrai poste a un rendu stable dans le temps ; un bruit qui changerait à
 * chaque appel serait lui-même un signal de détection.
 *
 * Fonction top-level pure (aucune closure sur des variables Node) : son code source est
 * sérialisé tel quel par Playwright pour tourner dans la page via `context.addInitScript`.
 */
function applyFingerprintNoise(seed: number): void {
  function pixelNoise(index: number): number {
    let h = (seed ^ index) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = (h ^ (h >>> 16)) >>> 0;
    return (h % 3) - 1; // -1, 0 ou 1
  }
  // Décide si CE pixel doit être bruité, avec un hash différent de `pixelNoise` (multiplicateur
  // distinct) pour ne pas corréler les deux tirages. Vérifié empiriquement via CreepJS
  // (abrahamjuliot.github.io/creepjs) : bruiter 100% des pixels est lui-même détecté et affiché
  // comme "16% rgba noise" — un signal "outil anti-fingerprint" à part entière. Un vrai rendu
  // GPU ne varie pas uniformément sur toute l'image ; ne toucher qu'une fraction des pixels
  // (~1/8) imite mieux une variance matérielle localisée plutôt qu'un bruit artificiel global.
  function shouldTouch(index: number): boolean {
    let h = (seed ^ Math.imul(index, 7919)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = (h ^ (h >>> 16)) >>> 0;
    return h % 8 === 0;
  }
  function clamp(v: number): number {
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  // --- Canvas 2D : getImageData / toDataURL / toBlob ---------------------------------------
  function noiseImageData(imageData: ImageData): ImageData {
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      // Un pixel totalement transparent (alpha = 0) n'a jamais été réellement peint : un vrai
      // navigateur n'y introduit aucune variance. Le bruiter quand même est un signal détectable
      // en soi (constaté sur bot.sannysoft.com : test "TRANSPARENT_PIXEL" marqué WARN).
      if (data[i + 3] === 0) continue;
      if (!shouldTouch(i)) continue;
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
  // que `getImageData` renverrait sur ce même contenu. Fonctionne aussi pour un canvas WebGL
  // (`drawImage` capture le rendu courant du framebuffer WebGL sur un canvas 2D normal).
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

  // --- WebGL : readPixels en direct (scripts qui n'exportent jamais via toDataURL) ---------
  function noiseWebglBuffer(pixels: unknown): void {
    if (!(pixels instanceof Uint8Array)) return; // format le plus courant (RGBA 8 bits/canal)
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] === 0) continue; // même raison que pour le canvas 2D
      if (!shouldTouch(i)) continue;
      pixels[i] = clamp(pixels[i] + pixelNoise(i));
      pixels[i + 1] = clamp(pixels[i + 1] + pixelNoise(i + 1));
      pixels[i + 2] = clamp(pixels[i + 2] + pixelNoise(i + 2));
    }
  }
  // `any` volontaire : les surcharges réelles de `readPixels` (WebGL1 vs WebGL2 avec PBO) ne
  // s'unifient pas proprement en un seul type de fonction générique, et ce code ne s'exécute de
  // toute façon jamais côté TypeScript/Node — seul son texte sérialisé tourne dans la page.
  function patchReadPixels(ctor: { prototype: Record<string, any> } | undefined): void {
    if (!ctor) return;
    const origReadPixels = ctor.prototype.readPixels;
    ctor.prototype.readPixels = function (this: unknown, ...args: unknown[]) {
      const result = origReadPixels.apply(this, args);
      // Dernier argument = le buffer de sortie (sauf variante WebGL2 avec PBO + offset numérique,
      // ignorée ici : `noiseWebglBuffer` ne fait rien sur un nombre).
      noiseWebglBuffer(args[args.length - 1]);
      return result;
    };
  }
  patchReadPixels(typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext : undefined);
  patchReadPixels(typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext : undefined);

  // --- Audio : AudioBuffer.getChannelData (OfflineAudioContext + lecture d'échantillons) ---
  if (typeof AudioBuffer !== 'undefined') {
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function (this: AudioBuffer, channel: number) {
      const original = origGetChannelData.call(this, channel);
      // Copie plutôt que mutation en place : l'AudioBuffer d'origine reste intact, donc chaque
      // appel repart des VRAIS échantillons + le même bruit déterministe, sans dérive cumulative
      // si la fonction est appelée plusieurs fois sur le même buffer/canal.
      const noised = new Float32Array(original.length);
      for (let i = 0; i < original.length; i++) {
        // Échelle minuscule (échantillons audio en [-1, 1]) : assez pour changer le hash, jamais
        // audible ni assez gros pour ressembler à une erreur de rendu.
        noised[i] = original[i] + pixelNoise(i) * 0.0000001;
      }
      return noised;
    };
  }
}

/**
 * Empêche WebRTC de révéler l'IP locale/publique réelle — le candidat ICE de type `host` expose
 * l'IP locale, `srflx`/`prflx` l'IP publique via un serveur STUN, ce qui contourne complètement
 * un proxy HTTP/SOCKS configuré par ailleurs (le trafic STUN est de l'UDP direct, pas du trafic
 * proxifié). C'est l'un des vecteurs de désanonymisation les plus critiques pour un profil qui
 * utilise un proxy : sans ça, toute la config proxy ne sert à rien pour peu qu'une page fasse le
 * classique test WebRTC (browserleaks.com, ipleak.net...).
 *
 * `RTCPeerConnection` reste fonctionnel et détectable comme présent (contrairement à le
 * supprimer entièrement, qui serait lui-même un signal suspect) : seuls les candidats qui
 * révéleraient une IP hors proxy sont filtrés, aussi bien via l'évènement `icecandidate`
 * (`addEventListener` et la propriété `onicecandidate`) que dans le SDP renvoyé par
 * `createOffer`/`createAnswer` (pour un code qui lit le SDP directement plutôt que d'écouter les
 * évènements). Seuls les candidats `relay` (TURN, donc déjà proxifiés) passent.
 *
 * Complémentaire au flag Chromium `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`
 * posé dans `build()`, qui bloque la fuite au niveau réseau (plus robuste, mais Chromium
 * seulement) — cette version JS couvre aussi WebKit, qui n'a pas d'équivalent en ligne de
 * commande.
 *
 * Fonction top-level pure (aucune closure sur des variables Node) : son code source est
 * sérialisé tel quel par Playwright pour tourner dans la page via `context.addInitScript`. `any`
 * ponctuel volontaire : ce code ne s'exécute jamais côté TypeScript/Node, seul son texte
 * sérialisé tourne dans la page, donc pas d'intérêt à lutter contre les typages DOM stricts ici.
 */
function blockWebRtcLeaks(): void {
  function isLeakyCandidateLine(text: string | null | undefined): boolean {
    return /typ (host|srflx|prflx)/.test(text || '');
  }
  function sanitizeSdp(sdp: string | undefined): string | undefined {
    if (!sdp) return sdp;
    return sdp
      .split('\r\n')
      .filter((line) => !(line.indexOf('a=candidate') === 0 && isLeakyCandidateLine(line)))
      .join('\r\n');
  }

  const RTCCtor = (window as any).RTCPeerConnection;
  if (!RTCCtor) return; // pas de WebRTC sur ce moteur/cette page : rien à protéger.
  const proto = RTCCtor.prototype as any;

  // 1) SDP renvoyé par createOffer/createAnswer, pour un code qui lit le SDP directement.
  for (const method of ['createOffer', 'createAnswer']) {
    const orig = proto[method];
    proto[method] = function (this: unknown, ...args: unknown[]) {
      const result = orig.apply(this, args);
      if (result && typeof result.then === 'function') {
        return result.then((desc: { sdp?: string }) => {
          if (desc && desc.sdp) desc.sdp = sanitizeSdp(desc.sdp);
          return desc;
        });
      }
      return result;
    };
  }

  // 2) Évènement `icecandidate` via addEventListener.
  const origAddEventListener = proto.addEventListener;
  proto.addEventListener = function (this: unknown, type: string, listener: unknown, ...rest: unknown[]) {
    if (type === 'icecandidate' && typeof listener === 'function') {
      const wrapped = function (this: unknown, event: any) {
        if (event && event.candidate && isLeakyCandidateLine(event.candidate.candidate)) {
          return;
        }
        return (listener as (...a: unknown[]) => unknown).call(this, event);
      };
      return origAddEventListener.call(this, type, wrapped, ...rest);
    }
    return origAddEventListener.call(this, type, listener, ...rest);
  };

  // 3) Évènement `icecandidate` via la propriété `onicecandidate` (chemin le plus courant dans
  // le code réel, qui ne passe pas forcément par addEventListener).
  const origDescriptor = Object.getOwnPropertyDescriptor(proto, 'onicecandidate');
  if (origDescriptor && origDescriptor.get && origDescriptor.set) {
    Object.defineProperty(proto, 'onicecandidate', {
      configurable: true,
      enumerable: origDescriptor.enumerable,
      get: origDescriptor.get,
      set(this: unknown, handler: unknown) {
        if (typeof handler !== 'function') {
          return origDescriptor.set!.call(this, handler);
        }
        const wrapped = function (this: unknown, event: any) {
          if (event && event.candidate && isLeakyCandidateLine(event.candidate.candidate)) {
            return;
          }
          return (handler as (...a: unknown[]) => unknown).call(this, event);
        };
        return origDescriptor.set!.call(this, wrapped);
      },
    });
  }
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

type PlatformCategory = 'windows' | 'macos' | 'android' | 'ios';

/**
 * Déduit la plateforme à simuler — pour le fingerprint de polices (`FONT_WHITELISTS`), mais
 * aussi `navigator.platform`/Client Hints ci-dessous — à partir de ce qu'on sait déjà du device :
 * `engine` (chromium routé côté Windows/Android, webkit côté macOS/iOS) et `isMobile` (desktop vs
 * mobile pour ce même moteur). Pas de nouvelle donnée nécessaire : ce sont exactement les infos
 * que `resolveEngineForDevice`/`pickDeviceConfig` ont déjà résolues.
 */
function choosePlatformCategory(engine: Engine, isMobile: boolean | undefined): PlatformCategory {
  if (engine === 'webkit') {
    return isMobile ? 'ios' : 'macos';
  }
  return isMobile ? 'android' : 'windows';
}

// Valeur de `navigator.platform` par plateforme. Note : "Win32" pour Windows n'est pas une
// erreur — même un vrai Chrome 64 bits sur Windows 10/11 rapporte "Win32" pour compat web, un
// comportement stable depuis des années.
const PLATFORM_STRINGS: Record<PlatformCategory, string> = {
  windows: 'Win32',
  macos: 'MacIntel',
  android: 'Linux armv8l',
  ios: 'iPhone',
};

/** `navigator.languages` doit dériver de la vraie locale du profil, pas d'une valeur figée. */
function deriveLanguages(locale: string): string[] {
  const primary = locale.replace(/_/g, '-');
  const short = primary.split('-')[0];
  return short && short !== primary ? [primary, short] : [primary];
}

/**
 * Corrige deux incohérences trouvées en testant contre bot.sannysoft.com/CreepJS sur un vrai
 * profil "desktop" (Windows) :
 *   - `navigator.platform` rapportait "Linux x86_64" malgré un UA Windows — l'option `userAgent`
 *     de Playwright ne synchronise QUE l'UA (en-tête + `navigator.userAgent`), jamais
 *     `navigator.platform`, qui reste donc la vraie valeur du système hôte sauf à l'écraser
 *     nous-mêmes ici.
 *   - `navigator.languages` valait `["en-US","en"]` même avec `locale: 'fr-FR'` configuré :
 *     l'évasion `navigator.languages` du plugin stealth a sa PROPRE valeur par défaut,
 *     indépendante de notre `locale` (elle ne lit pas nos options), et cette évasion est un
 *     singleton partagé au niveau module — pas moyen de la reconfigurer par profil. D'où
 *     l'exclusion de `navigator.languages` de `CHROMIUM_STEALTH_EVASIONS`/
 *     `GENERIC_STEALTH_EVASIONS` (cf. plus bas) au profit de cette version, dérivée de la vraie
 *     locale à chaque lancement.
 *
 * Fonction top-level pure (aucune closure sur des variables Node) : son code source est
 * sérialisé tel quel par Playwright pour tourner dans la page via `context.addInitScript`.
 */
function applyNavigatorOverrides(values: { platform: string; languages: string[] }): void {
  const proto = Object.getPrototypeOf(navigator);
  Object.defineProperty(proto, 'platform', {
    get: () => values.platform,
    configurable: true,
    enumerable: true,
  });
  const frozenLanguages = Object.freeze(values.languages.slice());
  Object.defineProperty(proto, 'languages', {
    get: () => frozenLanguages,
    configurable: true,
    enumerable: true,
  });
}

interface ClientHintsProfile {
  platform: string;
  mobile: boolean;
  platformVersion: string;
  architecture: string;
}

// `navigator.userAgentData` (Client Hints) n'existe que sur Chromium — WebKit/Safari ne
// l'implémente pas du tout, donc `applyClientHintsOverride` n'est appelée que pour ce moteur
// (cf. `build()`) ; ces valeurs iOS/macOS ne servent jamais en pratique mais restent définies
// pour la complétude du type `Record<PlatformCategory, ...>`.
const CLIENT_HINTS_BY_PLATFORM: Record<PlatformCategory, ClientHintsProfile> = {
  windows: { platform: 'Windows', mobile: false, platformVersion: '10.0.0', architecture: 'x86' },
  android: { platform: 'Android', mobile: true, platformVersion: '14.0.0', architecture: 'arm' },
  macos: { platform: 'macOS', mobile: false, platformVersion: '14.0.0', architecture: 'arm' },
  ios: { platform: 'macOS', mobile: true, platformVersion: '17.0.0', architecture: 'arm' },
};

/**
 * `navigator.userAgentData.getHighEntropyValues()` révélait littéralement la marque
 * "HeadlessChrome" (constaté via CreepJS) — ces Client Hints sont dérivés en interne du VRAI
 * build Chromium, pas de l'UA qu'on spoof via l'option `userAgent` de Playwright, qui ne les
 * touche pas du tout. On reconstruit un objet `NavigatorUAData` plausible à la place, avec la
 * VRAIE version majeure/complète extraite de `navigator.userAgent` (déjà correctement spoofée à
 * ce stade) pour rester cohérent avec elle plutôt que d'inventer un numéro de version différent.
 *
 * Fonction top-level pure (aucune closure sur des variables Node) : son code source est
 * sérialisé tel quel par Playwright pour tourner dans la page via `context.addInitScript`.
 */
function applyClientHintsOverride(profile: ClientHintsProfile): void {
  if (!('userAgentData' in navigator)) return; // moteur sans Client Hints (webkit) : rien à faire
  const uaMatch = navigator.userAgent.match(/Chrome\/([\d.]+)/);
  const fullVersion = uaMatch ? uaMatch[1] : '120.0.0.0';
  const majorVersion = fullVersion.split('.')[0];

  const brands = [
    { brand: 'Not_A Brand', version: '8' },
    { brand: 'Chromium', version: majorVersion },
    { brand: 'Google Chrome', version: majorVersion },
  ];
  const fullVersionList = [
    { brand: 'Not_A Brand', version: '8.0.0.0' },
    { brand: 'Chromium', version: fullVersion },
    { brand: 'Google Chrome', version: fullVersion },
  ];

  const uaData = {
    brands,
    mobile: profile.mobile,
    platform: profile.platform,
    toJSON() {
      return { brands, mobile: profile.mobile, platform: profile.platform };
    },
    getHighEntropyValues(hints?: string[]) {
      const full: Record<string, unknown> = {
        brands,
        mobile: profile.mobile,
        platform: profile.platform,
        platformVersion: profile.platformVersion,
        architecture: profile.architecture,
        bitness: '64',
        model: '',
        uaFullVersion: fullVersion,
        fullVersionList,
        wow64: false,
      };
      const requested = hints && hints.length ? hints : ['brands', 'mobile', 'platform'];
      const result: Record<string, unknown> = {};
      for (const key of requested) {
        if (key in full) result[key] = full[key];
      }
      return Promise.resolve(result);
    },
  };

  Object.defineProperty(Object.getPrototypeOf(navigator), 'userAgentData', {
    get: () => uaData,
    configurable: true,
    enumerable: true,
  });

  // Expose (caché, non énumérable) les valeurs sources derrière `uaData` : `patchWorkerFingerprint`
  // et le patch réseau de Service Worker en ont besoin pour reconstruire le MÊME
  // `navigator.userAgentData` à l'intérieur d'un Worker/Service Worker (qui a sa propre portée
  // globale, cf. leur doc), sans redériver `fullVersion`/`majorVersion` séparément et risquer une
  // incohérence entre le thread principal et ces autres contextes.
  Object.defineProperty(window as any, '__stealthClientHints', {
    value: { fullVersion, profile },
    configurable: true,
    enumerable: false,
  });
}

/**
 * Découverte en testant contre CreepJS : un Worker dédié rapportait `navigator.userAgent`
 * ("HeadlessChrome"/Linux brut, non spoofé), `navigator.platform` ("Linux x86_64") et
 * `navigator.hardwareConcurrency` (16, le vrai nombre de coeurs de la machine hôte, au lieu du 4
 * de l'évasion stealth) — l'option `userAgent` de Playwright et les autres correctifs ci-dessus
 * ne s'appliquent qu'au(x) frame(s) de la page, jamais aux Workers, qui ont leur propre portée
 * globale (`self`, pas `window`). Un script qui vérifie le fingerprint depuis un Worker
 * contournait donc TOUT le reste de la furtivité.
 *
 * Contournement : on intercepte le constructeur `Worker` pour faire exécuter un petit
 * "bootstrap" dans le worker AVANT son propre script — on y recopie les valeurs déjà correctes
 * du thread principal (`navigator.userAgent`/`platform`/`hardwareConcurrency`, tous déjà
 * spoofés à ce stade). Deux cas :
 *   - Vraie URL de script (`new Worker('script.js')`) : on charge le vrai script via
 *     `importScripts` (synchrone dans un worker, contrairement à `fetch`), résolue en absolue
 *     au préalable (une URL relative ne se résout pas correctement depuis la base d'une URL
 *     blob:, cf. plus bas).
 *   - Worker construit depuis un blob:/data: (courant pour des libs qui embarquent leur worker
 *     inline plutôt que dans un fichier séparé — constaté sur CreepJS lui-même, dont le worker
 *     échappait initialement à ce correctif pour cette raison précise) : le contenu est déjà
 *     local, récupéré par une XHR SYNCHRONE (instantanée, aucun aller-retour réseau) puis collé
 *     directement après notre patch, sans `importScripts`.
 *
 * Fonction top-level pure (aucune closure sur des variables Node) : son code source est
 * sérialisé tel quel par Playwright pour tourner dans la page via `context.addInitScript`. Volue
 * `any` ponctuels : ce code ne s'exécute jamais côté TypeScript/Node, seul son texte sérialisé
 * tourne dans la page.
 */
function patchWorkerFingerprint(): void {
  const patchParts = [
    `Object.defineProperty(Object.getPrototypeOf(navigator), 'userAgent', { get: () => ${JSON.stringify(navigator.userAgent)}, configurable: true });`,
    `Object.defineProperty(Object.getPrototypeOf(navigator), 'platform', { get: () => ${JSON.stringify(navigator.platform)}, configurable: true });`,
    `Object.defineProperty(Object.getPrototypeOf(navigator), 'hardwareConcurrency', { get: () => ${navigator.hardwareConcurrency}, configurable: true });`,
  ];

  // `navigator.userAgentData` (cf. doc d'`applyClientHintsOverride`) a, comme le reste, sa propre
  // portée dans un Worker : sans ce bloc, CreepJS le révélait toujours en clair ("HeadlessChrome",
  // "Linux x86_64") depuis SON worker, alors même que userAgent/platform/hardwareConcurrency y
  // étaient déjà correctement corrigés par le reste de cette fonction — repéré en re-vérifiant
  // empiriquement après ce premier correctif. On relit les valeurs déjà calculées par
  // `applyClientHintsOverride` (exposées via `window.__stealthClientHints`) plutôt que de
  // redériver `fullVersion` ici, pour rester cohérent avec le thread principal.
  const hints = (window as any).__stealthClientHints as
    | { fullVersion: string; profile: { platform: string; mobile: boolean; platformVersion: string; architecture: string } }
    | undefined;
  if (hints) {
    const majorVersion = hints.fullVersion.split('.')[0];
    const brands = [
      { brand: 'Not_A Brand', version: '8' },
      { brand: 'Chromium', version: majorVersion },
      { brand: 'Google Chrome', version: majorVersion },
    ];
    const fullVersionList = [
      { brand: 'Not_A Brand', version: '8.0.0.0' },
      { brand: 'Chromium', version: hints.fullVersion },
      { brand: 'Google Chrome', version: hints.fullVersion },
    ];
    patchParts.push(
      '(function(){' +
        "if (!('userAgentData' in navigator)) return;" +
        `var brands=${JSON.stringify(brands)};` +
        `var fullVersionList=${JSON.stringify(fullVersionList)};` +
        `var profile=${JSON.stringify(hints.profile)};` +
        'var uaData={brands:brands,mobile:profile.mobile,platform:profile.platform,' +
        'toJSON:function(){return {brands:brands,mobile:profile.mobile,platform:profile.platform};},' +
        'getHighEntropyValues:function(hs){' +
        `var full={brands:brands,mobile:profile.mobile,platform:profile.platform,platformVersion:profile.platformVersion,architecture:profile.architecture,bitness:'64',model:'',uaFullVersion:${JSON.stringify(hints.fullVersion)},fullVersionList:fullVersionList,wow64:false};` +
        "var req=(hs&&hs.length)?hs:['brands','mobile','platform'];" +
        'var res={};for(var i=0;i<req.length;i++){if(req[i] in full) res[req[i]]=full[req[i]];}' +
        'return Promise.resolve(res);' +
        '}};' +
        "Object.defineProperty(Object.getPrototypeOf(navigator),'userAgentData',{get:function(){return uaData;},configurable:true});" +
        '})();'
    );
  }

  const patchSource = patchParts.join('\n');

  function wrap(OriginalCtor: any): any {
    function Patched(this: unknown, scriptURL: any, options?: any) {
      const urlString = String(scriptURL);
      let bootstrap: string;
      if (urlString.startsWith('blob:') || urlString.startsWith('data:')) {
        // Cas très courant (libs qui embarquent leur worker inline plutôt que dans un fichier
        // séparé — constaté sur CreepJS lui-même) : pas de "vraie" URL à passer à
        // `importScripts`, mais le contenu est déjà local (aucun aller-retour réseau), donc une
        // XHR SYNCHRONE le récupère instantanément — on colle alors notre patch directement en
        // tête du code source, sans passer par `importScripts`.
        try {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', urlString, false);
          xhr.send(null);
          bootstrap = `${patchSource}\n${xhr.responseText}`;
        } catch {
          return new OriginalCtor(scriptURL, options); // repli si la lecture échoue pour une raison quelconque
        }
      } else {
        // Résolue en absolue AVANT d'être passée à `importScripts` : le bootstrap tourne depuis
        // une URL blob:, qui n'a pas la même base que la page pour résoudre une URL relative —
        // vérifié empiriquement, un `new Worker('/worker.js')` échouait silencieusement
        // (`importScripts` ne trouvait rien) sans cette résolution.
        const absoluteUrl = new URL(urlString, location.href).href;
        bootstrap = `${patchSource}\nimportScripts(${JSON.stringify(absoluteUrl)});`;
      }
      const blob = new Blob([bootstrap], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      return new OriginalCtor(blobUrl, options);
    }
    Patched.prototype = OriginalCtor.prototype;
    return Patched;
  }

  if (typeof Worker !== 'undefined') {
    (window as any).Worker = wrap(Worker);
  }
  if (typeof (window as any).SharedWorker !== 'undefined') {
    (window as any).SharedWorker = wrap((window as any).SharedWorker);
  }
}

/**
 * Reconstruit, comme fragment de texte JS, le même `navigator.userAgentData` que
 * `applyClientHintsOverride` (cf. sa doc) — mais appelée côté Node par `patchServiceWorkerFingerprint`
 * (donc PAS elle-même sérialisée par `context.addInitScript`, contrairement à toutes les
 * fonctions top-level pures ci-dessus), pour produire le texte à préfixer à la réponse d'un
 * Service Worker. `fullVersion`/`profile` proviennent de `window.__stealthClientHints`, lu sur la
 * page via `page.evaluate` juste avant, pour rester cohérent avec le thread principal.
 */
function buildClientHintsBootstrapSource(
  fullVersion: string,
  profile: { platform: string; mobile: boolean; platformVersion: string; architecture: string }
): string {
  const majorVersion = fullVersion.split('.')[0];
  const brands = [
    { brand: 'Not_A Brand', version: '8' },
    { brand: 'Chromium', version: majorVersion },
    { brand: 'Google Chrome', version: majorVersion },
  ];
  const fullVersionList = [
    { brand: 'Not_A Brand', version: '8.0.0.0' },
    { brand: 'Chromium', version: fullVersion },
    { brand: 'Google Chrome', version: fullVersion },
  ];
  return (
    '(function(){' +
    "if (!('userAgentData' in navigator)) return;" +
    `var brands=${JSON.stringify(brands)};` +
    `var fullVersionList=${JSON.stringify(fullVersionList)};` +
    `var profile=${JSON.stringify(profile)};` +
    'var uaData={brands:brands,mobile:profile.mobile,platform:profile.platform,' +
    'toJSON:function(){return {brands:brands,mobile:profile.mobile,platform:profile.platform};},' +
    'getHighEntropyValues:function(hs){' +
    `var full={brands:brands,mobile:profile.mobile,platform:profile.platform,platformVersion:profile.platformVersion,architecture:profile.architecture,bitness:'64',model:'',uaFullVersion:${JSON.stringify(fullVersion)},fullVersionList:fullVersionList,wow64:false};` +
    "var req=(hs&&hs.length)?hs:['brands','mobile','platform'];" +
    'var res={};for(var i=0;i<req.length;i++){if(req[i] in full) res[req[i]]=full[req[i]];}' +
    'return Promise.resolve(res);' +
    '}};' +
    "Object.defineProperty(Object.getPrototypeOf(navigator),'userAgentData',{get:function(){return uaData;},configurable:true});" +
    '})();'
  );
}

/**
 * Découverte en testant contre tls.peet.ws (capture des vrais en-têtes HTTP envoyés) : Chromium
 * envoie lui-même l'en-tête `Sec-CH-UA` — ex. `"HeadlessChrome";v="153", "Not_A Brand";v="8",
 * "Chromium";v="153"` — sur CHAQUE requête, calculé en interne à partir du binaire réellement
 * exécuté (le build headless), totalement indépendamment de notre override JS de
 * `navigator.userAgentData` (`applyClientHintsOverride`) : cet en-tête part sur le réseau avant
 * qu'une seule ligne de JS ne tourne, invisible à CreepJS ou tout autre test purement côté page
 * (qui ne peut lire que le JS, pas ses propres en-têtes sortants) — un WAF côté serveur le voit
 * dès la toute première requête. Fait notable : `Sec-CH-UA-Platform` ressortait déjà correct
 * ("Windows") sans rien faire, seul `Sec-CH-UA` porte la marque "HeadlessChrome".
 *
 * Essayé d'abord via `context.route()` (réécrire l'en-tête sortant à l'interception) : ÉCHEC
 * vérifié empiriquement sur tls.peet.ws — Chromium réinjecte sa propre valeur de `Sec-CH-UA`
 * APRÈS l'interception `Fetch`/`route.continue({headers})` sur une requête de navigation, quel
 * que soit ce qu'on lui passe. Fonctionne en revanche via `context.setExtraHTTPHeaders()`, un
 * mécanisme CDP différent et de plus bas niveau (`Network.setExtraHTTPHeaders`) — vérifié
 * empiriquement que celui-ci survit et remplace bien la valeur envoyée sur le réseau. On ne fixe
 * QUE `Sec-CH-UA` (le seul confirmé envoyé par défaut et confirmé fuyant) : son équivalent
 * haute-entropie `Sec-CH-UA-Full-Version-List` n'est envoyé que si le serveur l'a demandé via
 * `Accept-CH` — le forcer systématiquement sur CHAQUE requête (`setExtraHTTPHeaders` ne peut pas
 * être conditionnel par requête) risquerait de créer un signal inverse : un vrai navigateur
 * n'envoie jamais ce header non sollicité.
 */
function computeCorrectedSecChUa(ua: string): string {
  const uaMatch = ua.match(/Chrome\/([\d.]+)/);
  const majorVersion = (uaMatch ? uaMatch[1] : '120.0.0.0').split('.')[0];
  return `"Not_A Brand";v="8", "Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}"`;
}

/**
 * Découverte en testant contre CreepJS : elle fingerprinte depuis un Service Worker
 * (`navigator.serviceWorker.register()`), pas un Worker dédié — un mécanisme fondamentalement
 * différent (persistant, rattaché à l'origine plutôt qu'à une page, ne peut pas être instancié
 * depuis un blob:/data:) auquel `patchWorkerFingerprint` (qui intercepte le constructeur
 * `Worker`) ne peut structurellement pas accéder : rien côté JS de la page ne construit ce
 * Service Worker, c'est le navigateur qui va chercher son script directement.
 *
 * Contournement au niveau réseau plutôt que JS : `context.route()` intercepte toutes les
 * requêtes du contexte, mais on ne réécrit le CORPS de la réponse QUE pour celles dont
 * `request.serviceWorker()` est non-null — vérifié empiriquement sur un vrai Service Worker
 * local que cette méthode Playwright distingue fiablement une requête appartenant à
 * l'exécution d'un Service Worker (son script initial, ou un `importScripts()` fait depuis lui)
 * d'une requête de script ordinaire de la page, pour laquelle elle vaut `null`. Ce ciblage précis
 * est essentiel : réécrire le corps de TOUS les scripts JS casserait le Subresource Integrity
 * (SRI, `<script integrity="sha384-...">`) de scripts légitimes sans rapport sur un vrai site
 * cible — jamais de ciblage par `resourceType()`/extension, qui inclurait des scripts normaux en
 * plus des Service Workers.
 *
 * `clientHintsProfile` est passé directement par `build()` (le même `CLIENT_HINTS_BY_PLATFORM[...]`
 * que pour `applyClientHintsOverride`) plutôt que relu sur `window.__stealthClientHints` : cette
 * fonction s'exécute juste après `context.newPage()`, sur une page encore vierge (`about:blank`),
 * et `applyClientHintsOverride` s'y arrête tôt (`if (!('userAgentData' in navigator)) return;`) —
 * `navigator.userAgentData` n'existe pas dans un contexte non sécurisé comme `about:blank` (cf.
 * doc de `applyClientHintsOverride` et le test Client Hints, qui navigue vers une vraie page HTTPS
 * pour cette même raison) — donc `__stealthClientHints` n'y est jamais posé. `fullVersion` est en
 * revanche dérivé de `navigator.userAgent`, lui déjà correct même sur `about:blank`.
 */
async function patchServiceWorkerFingerprint(
  context: BrowserContext,
  page: Page,
  clientHintsProfile: ClientHintsProfile | null
): Promise<void> {
  const fp = await page.evaluate(() => ({
    ua: navigator.userAgent,
    platform: navigator.platform,
    cores: navigator.hardwareConcurrency,
  }));

  let clientHints: { fullVersion: string; profile: ClientHintsProfile } | null = null;
  if (clientHintsProfile) {
    const uaMatch = fp.ua.match(/Chrome\/([\d.]+)/);
    const fullVersion = uaMatch ? uaMatch[1] : '120.0.0.0';
    clientHints = { fullVersion, profile: clientHintsProfile };
  }

  await context.route('**/*', async (route) => {
    const request = route.request();
    if (!request.serviceWorker()) {
      await route.continue();
      return;
    }

    try {
      const response = await route.fetch();
      const body = await response.text();
      const patchParts = [
        `Object.defineProperty(Object.getPrototypeOf(navigator), 'userAgent', { get: () => ${JSON.stringify(fp.ua)}, configurable: true });`,
        `Object.defineProperty(Object.getPrototypeOf(navigator), 'platform', { get: () => ${JSON.stringify(fp.platform)}, configurable: true });`,
        `Object.defineProperty(Object.getPrototypeOf(navigator), 'hardwareConcurrency', { get: () => ${fp.cores}, configurable: true });`,
      ];
      if (clientHints) {
        patchParts.push(buildClientHintsBootstrapSource(clientHints.fullVersion, clientHints.profile));
      }
      const patch = patchParts.join('\n');
      await route.fulfill({ response, body: `${patch}\n${body}` });
    } catch {
      await route.continue(); // repli si l'interception échoue pour une raison quelconque (réponse non textuelle, etc.)
    }
  });
}

/**
 * Polices réellement présentes sur chaque plateforme réelle (liste non exhaustive mais couvrant
 * les polices les plus couramment sondées par les scripts de fingerprint). Le but n'est pas de
 * cacher que Liberation Sans/DejaVu/Noto rendent le texte (le rendu visuel est bon, notamment
 * pour Arial/Times New Roman/Courier New/Calibri, déjà correctement substitués par fontconfig
 * en polices métriquement compatibles côté système) — c'est d'empêcher qu'une sonde de police
 * PAR NOM révèle des polices qui n'existeraient jamais sur la plateforme prétendue : une vraie
 * machine Windows n'a pas "Liberation Sans"/"DejaVu Sans"/"Noto Sans"/"Carlito" installées SOUS
 * CES NOMS, donc les détecter comme présentes serait une signature Linux immédiate, quelle que
 * soit par ailleurs la qualité de la substitution d'Arial/Calibri.
 */
const FONT_WHITELISTS: Record<PlatformCategory, string[]> = {
  windows: [
    'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Cambria Math', 'Candara',
    'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Ebrima',
    'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia', 'Impact', 'Ink Free',
    'Javanese Text', 'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic',
    'Marlett', 'Microsoft Himalaya', 'Microsoft JhengHei', 'Microsoft New Tai Lue',
    'Microsoft PhagsPa', 'Microsoft Sans Serif', 'Microsoft Tai Le', 'Microsoft YaHei',
    'Microsoft Yi Baiti', 'MingLiU-ExtB', 'Mongolian Baiti', 'MS Gothic', 'MV Boli',
    'Myanmar Text', 'Nirmala UI', 'Palatino Linotype', 'Segoe MDL2 Assets', 'Segoe Print',
    'Segoe Script', 'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Historic', 'Segoe UI Symbol',
    'SimSun', 'Sitka', 'Sylfaen', 'Symbol', 'Tahoma', 'Times New Roman', 'Trebuchet MS',
    'Verdana', 'Webdings', 'Wingdings', 'Yu Gothic',
  ],
  macos: [
    'Helvetica Neue', 'Helvetica', 'Lucida Grande', 'Geneva', 'Monaco', 'American Typewriter',
    'Arial', 'Arial Black', 'Avenir', 'Avenir Next', 'Baskerville', 'Big Caslon', 'Bodoni 72',
    'Bradley Hand', 'Chalkboard', 'Cochin', 'Comic Sans MS', 'Copperplate', 'Courier',
    'Courier New', 'Didot', 'Futura', 'Garamond', 'Georgia', 'Gill Sans', 'Herculanum',
    'Hoefler Text', 'Impact', 'Marker Felt', 'Menlo', 'Optima', 'Palatino', 'Papyrus',
    'Phosphate', 'Rockwell', 'Savoye LET', 'SignPainter', 'Skia', 'Snell Roundhand', 'Tahoma',
    'Times', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Zapfino',
  ],
  android: [
    'Roboto', 'Roboto Condensed', 'Roboto Slab', 'Noto Sans', 'Noto Color Emoji', 'Droid Sans',
    'Droid Sans Mono', 'Droid Serif', 'sans-serif-thin', 'sans-serif-light', 'sans-serif-medium',
    'sans-serif-black', 'Google Sans',
  ],
  ios: [
    'Helvetica Neue', 'Helvetica', 'Arial', 'Courier New', 'Georgia', 'Times New Roman',
    'Trebuchet MS', 'Verdana', 'American Typewriter', 'Avenir', 'Avenir Next', 'Baskerville',
    'Chalkboard SE', 'Cochin', 'Copperplate', 'Didot', 'Futura', 'Gill Sans', 'Marker Felt',
    'Menlo', 'Noteworthy', 'Optima', 'Palatino', 'Papyrus', 'PingFang HK', 'PingFang SC',
    'PingFang TC', 'Rockwell', 'Zapfino',
  ],
};

/**
 * Fait mentir les deux techniques de sonde de police les plus utilisées (mesure canvas via
 * `measureText`, la plus fréquente dans les libs de fingerprint modernes type FingerprintJS, et
 * `document.fonts.check`) pour qu'une police hors de `allowedFonts` semble absente — même si
 * elle est réellement installée sur cette machine Linux — en la faisant retomber sur le
 * générique (`serif`/`sans-serif`/`monospace`/...) explicitement fourni par l'appelant dans sa
 * pile de polices, exactement comme le ferait un vrai navigateur pour une police non installée.
 *
 * Fonction top-level pure (aucune closure sur des variables Node) : son code source est
 * sérialisé tel quel par Playwright pour tourner dans la page via `context.addInitScript`.
 */
function applyFontFingerprintDefense(allowedFonts: string[]): void {
  const allowed = new Set(allowedFonts.map((f) => f.toLowerCase()));
  const GENERIC = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', '-apple-system',
    'blinkmacsystemfont',
  ]);

  function parseFamilies(fontCss: string): string[] {
    const m = fontCss.match(/(?:\d+(?:\.\d+)?(?:px|pt|em)\s+)(.+)$/);
    if (!m) return [];
    return m[1].split(',').map((f) => f.trim().replace(/^["']|["']$/g, ''));
  }
  function isAllowed(family: string): boolean {
    const lower = family.toLowerCase();
    return GENERIC.has(lower) || allowed.has(lower);
  }

  const origMeasureText = CanvasRenderingContext2D.prototype.measureText;
  CanvasRenderingContext2D.prototype.measureText = function (this: CanvasRenderingContext2D, text: string) {
    const families = parseFamilies(this.font);
    const requested = families[0];
    if (requested && !isAllowed(requested)) {
      const genericFallback = families.find((f) => GENERIC.has(f.toLowerCase())) || 'sans-serif';
      const savedFont = this.font;
      this.font = this.font.replace(requested, genericFallback);
      const result = origMeasureText.call(this, text);
      this.font = savedFont;
      return result;
    }
    return origMeasureText.call(this, text);
  };

  const fontsSet = (document as any).fonts;
  if (fontsSet && typeof fontsSet.check === 'function') {
    const origCheck = fontsSet.check.bind(fontsSet);
    fontsSet.check = function (fontCss: string, text?: string) {
      const requested = parseFamilies(fontCss)[0];
      if (requested && !isAllowed(requested)) {
        return false;
      }
      return origCheck(fontCss, text);
    };
  }
}

// `user-agent-override` est exclue même côté Chromium (elle est activée par défaut dans le
// jeu complet du plugin) : elle recalcule sa propre valeur à partir de l'UA brut du
// navigateur (avec un masquage Linux -> Windows) sans connaître l'UA explicite que
// `pickDeviceConfig` fixe déjà pour chaque device (ex. Android), et l'écrase donc via son
// override CDP. Vérifié empiriquement : avec cette évasion active, un device 'Pixel 7'
// ressortait avec un UA desktop Windows au lieu de l'UA Android attendu. Playwright gère déjà
// nativement l'UA (et l'en-tête HTTP associé) via l'option de contexte `userAgent` qu'on
// passe nous-mêmes — pas besoin de cette évasion pour ça.
// `navigator.languages` est exclue aussi (cf. doc de `applyNavigatorOverrides`) : sa valeur par
// défaut ('en-US','en') est fixe au niveau du plugin, indépendante de la vraie `locale` du
// profil — vérifié empiriquement, un profil `locale: 'fr-FR'` ressortait quand même avec
// `navigator.languages: ['en-US','en']`, en désaccord avec son propre `navigator.language`.
const CHROMIUM_STEALTH_EVASIONS = new Set(
  [...stealth().availableEvasions].filter((e) => e !== 'user-agent-override' && e !== 'navigator.languages')
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
// `navigator.languages` exclue pour la même raison que côté Chromium (cf. commentaire sur
// `CHROMIUM_STEALTH_EVASIONS` et doc de `applyNavigatorOverrides`) : valeur figée par le plugin,
// indépendante de la vraie `locale` du profil.
const GENERIC_STEALTH_EVASIONS = new Set([
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
                  // Empêche WebRTC d'utiliser de l'UDP non-proxifié pour la découverte ICE : sans
                  // ça, un candidat srflx (IP publique via STUN, en UDP direct) contournerait
                  // n'importe quel proxy HTTP/SOCKS configuré par ailleurs. Défense native
                  // Chromium, complémentaire à `blockWebRtcLeaks` (cf. driverBuilder.ts) qui
                  // couvre en plus WebKit, sans équivalent en ligne de commande.
                  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
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

        // Bruit de fingerprint déterministe par profil (canvas/WebGL/audio, cf. doc de
        // `applyFingerprintNoise`) : seedé sur `profileDir`, donc stable pour CE profil (même
        // fingerprint à chaque relance d'un profil nommé) mais différent d'un profil à l'autre,
        // même device/proxy/timezone identiques. S'applique aux deux moteurs, avant même la
        // création de la page.
        await context.addInitScript(applyFingerprintNoise, hashToSeed(profileDir));

        // Anti-fuite WebRTC (cf. doc de `blockWebRtcLeaks`) : pas de seed, le comportement est
        // le même pour tous les profils (bloquer la fuite, pas la varier).
        await context.addInitScript(blockWebRtcLeaks);

        // Défense fingerprint de polices (cf. doc de `applyFontFingerprintDefense`) : la
        // plateforme simulée découle de ce qu'on sait déjà (`engine` + `isMobile`), pas besoin
        // d'info supplémentaire sur le device.
        const platformCategory = choosePlatformCategory(engine, (deviceConfig as { isMobile?: boolean }).isMobile);
        await context.addInitScript(applyFontFingerprintDefense, FONT_WHITELISTS[platformCategory]);

        // navigator.platform + navigator.languages (cf. doc de `applyNavigatorOverrides`) :
        // incohérences trouvées en testant contre bot.sannysoft.com/CreepJS sur un vrai profil.
        await context.addInitScript(applyNavigatorOverrides, {
          platform: PLATFORM_STRINGS[platformCategory],
          languages: deriveLanguages(this.locale),
        });

        // Client Hints (cf. doc de `applyClientHintsOverride`) : Chromium seulement, l'API
        // n'existe pas sur WebKit.
        if (engine === 'chromium') {
          await context.addInitScript(applyClientHintsOverride, CLIENT_HINTS_BY_PLATFORM[platformCategory]);
        }

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

        // Fingerprint des Web Workers (cf. doc de `patchWorkerFingerprint`) : enregistré
        // seulement MAINTENANT, après `context.newPage()`. Il lit `navigator.hardwareConcurrency`
        // pour le recopier dans chaque worker, une valeur fixée par une évasion du plugin
        // stealth qui s'applique au niveau PAGE (via le hook `onPageCreated` de playwright-extra,
        // déclenché par `newPage()` ci-dessus) plutôt qu'au niveau contexte comme nos propres
        // scripts. Vérifié empiriquement : enregistré avant `newPage()`, ce script s'exécutait
        // avant que l'évasion stealth n'ait eu la chance de tourner sur cette page, et lisait
        // donc encore la vraie valeur de la machine hôte (16 coeurs) plutôt que le 4 attendu.
        await context.addInitScript(patchWorkerFingerprint);

        // En-tête HTTP Sec-CH-UA (cf. doc de `computeCorrectedSecChUa`) : envoyé par Chromium
        // lui-même, "HeadlessChrome" en clair, trouvé en inspectant les en-têtes bruts via
        // tls.peet.ws — indépendant de tout ce qu'on patche en JS. `context.setExtraHTTPHeaders`
        // est le seul mécanisme qui survit (route.continue({headers}) échoue, Chromium réinjecte
        // sa propre valeur après coup, vérifié empiriquement).
        const clientHintsProfile = engine === 'chromium' ? CLIENT_HINTS_BY_PLATFORM[platformCategory] : null;
        if (clientHintsProfile) {
          const realUa = await page.evaluate(() => navigator.userAgent);
          await context.setExtraHTTPHeaders({ 'sec-ch-ua': computeCorrectedSecChUa(realUa) });
        }

        // Fingerprint des Service Workers (cf. doc de `patchServiceWorkerFingerprint`) :
        // mécanisme distinct des Workers dédiés ci-dessus, inatteignable par une interception du
        // constructeur `Worker` — patché au niveau réseau via `context.route()`.
        await patchServiceWorkerFingerprint(context, page, clientHintsProfile);

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