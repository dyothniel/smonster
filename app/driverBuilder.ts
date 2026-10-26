// `chromium` vient de `patchright` (fork de playwright-core, cf. doc sur `engineArgs` dans
// `build()`) : corrige la fuite CDP `Runtime.enable` ("runtimeEnableLeak" sur
// bot-detector.rebrowser.net) que Playwright classique laisse passer, sans dépendre d'un plugin
// stealth tiers (cf. plus bas, suppression de `playwright-extra`/`puppeteer-extra-plugin-stealth`
// : plusieurs de ses évasions s'appuient sur `new Proxy(...)`, détectables structurellement, ET
// une au moins — `iframe.contentWindow` — est désormais reconnue NOMMÉMENT par cet outil comme
// signature de cette librairie précise, donc un risque net plutôt qu'un correctif discret).
import { chromium } from 'patchright';
// `webkit` reste sur le paquet `playwright` standard (et pas `patchright`) : Patchright ne patche
// QUE Chromium, et son fork de webkit cible une révision de binaire différente de celle déjà
// installée sur cette machine pour `playwright` — vérifié empiriquement, lancer `patchright`'s
// webkit échoue ("Executable doesn't exist at .../webkit-2370/...") et demanderait un nouveau
// téléchargement, inutile puisque webkit n'a de toute façon aucune évasion anti-détection
// spécifique côté Patchright à en tirer.
// `devices` : son typage expose le même piège sous `playwright-extra` ET `patchright` (intersection
// avec un tableau qui pollue `keyof typeof devices` de `symbol`, TS2731 sur le template literal
// plus bas) — importé depuis le paquet `playwright` tout nu pour l'éviter.
import { webkit, devices as playwrightDevices } from 'playwright';
// Types pris sur `patchright` (pas `playwright`) : `chromium` ci-dessus en vient, et c'est lui
// qui construit la quasi-totalité des `BrowserContext`/`Page`/`Browser` de ce fichier. Les deux
// paquets sont des forks quasi identiques du même code (patchright-core dérive de
// playwright-core), structurellement interchangeables à l'exécution, mais TypeScript les traite
// comme des types NOMINALEMENT distincts (classes avec membres privés) — d'où le cast explicite
// au seul endroit où `webkit` (resté sur `playwright`, cf. import ci-dessus) produit un objet
// réellement typé `playwright-core`, dans `build()`.
import type { Browser, BrowserContext, Page } from 'patchright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { ProxyRotator } from './proxyRotator';

type Engine = 'chromium' | 'webkit';

/**
 * Lit l'état de la page dans le MONDE PRINCIPAL plutôt que le monde isolé où `page.evaluate`
 * s'exécute par défaut côté Chromium sous Patchright (son mécanisme anti-fuite `Runtime.enable`,
 * cf. doc sur l'import de `chromium` plus haut). Découvert en vérifiant empiriquement qu'un
 * correctif posé via `context.addInitScript` (monde principal) est invisible à un `page.evaluate`
 * isolé : chaque monde JS a sa PROPRE copie des prototypes des objets DOM/WebIDL (`navigator`,
 * `WebGLRenderingContext`...), même si le DOM sous-jacent reste partagé — un comportement hérité
 * du modèle "isolated world" des content scripts d'extension, que Patchright réutilise.
 *
 * `engine` est nécessaire (pas de détection auto) : le 4e argument positionnel qui désactive le
 * monde isolé (signature `evaluate<R>(pageFunction, arg?, options?, isolatedContext?)` de
 * `patchright-core`) fait PLANTER `webkit`, resté sur `playwright` classique — vérifié
 * empiriquement, contrairement à une hypothèse initiale optimiste ("arguments en trop ignorés
 * silencieusement"), son implémentation lève `Too many arguments. If you need to pass more than
 * 1 argument to the function wrap them in an object.` dès qu'un 3e argument positionnel est
 * fourni, peu importe sa valeur.
 */
export function mainWorldEvaluate<R>(page: Page, pageFunction: () => R, engine: Engine): Promise<R> {
  if (engine === 'webkit') {
    return page.evaluate(pageFunction);
  }
  return page.evaluate(pageFunction, undefined, undefined, false);
}

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
  // Un `fn.toString()` sur une fonction qu'on vient de réécrire révèle notre code source au lieu
  // de "function x() { [native code] }" — un signal de détection de "masking" direct (constaté
  // sur pixelscan.net). On capture le VRAI résultat natif AVANT d'écraser la fonction, puis on
  // fait mentir `Function.prototype.toString` spécifiquement pour CETTE fonction patchée. Chaque
  // appel empile un nouveau Proxy par-dessus le précédent (chacun ne gère que SA fonction, et
  // délègue à `target` — la couche du dessous — sinon), donc patcher plusieurs fonctions
  // s'accumule proprement sans écraser les patches précédents.
  function patchToStringNative(patchedFn: unknown, nativeStr: string): void {
    // Découvert via bot-detector.rebrowser.net ("nativeTampering") : un `new Proxy(...)` sur
    // `Function.prototype.toString` se détecte STRUCTURELLEMENT (ex. test de cycle sur
    // `__proto__`), indépendamment de ce que le piège `apply` renvoie — masquer le CONTENU du
    // `toString()` ne suffit pas si l'objet lui-même reste un Proxy repérable. On utilise donc
    // une fonction normale fermée sur une `WeakMap` plutôt qu'un Proxy : chaque appel de
    // `patchToStringNative` chaîne un nouveau remplaçant (fonction normale, pas Proxy) par-dessus
    // le précédent `Function.prototype.toString` (qui, après le tout premier appel, n'est déjà
    // plus un Proxy lui non plus), avec repli vers lui pour toute fonction non enregistrée.
    // Syntaxe méthode (`toString(){}` dans un littéral objet) plutôt que `function(){}` : une
    // fonction normale a une `.prototype` propre par défaut (signal de détection distinct, repéré
    // sur `HTMLCanvasElement.toDataURL` via le même outil), une méthode n'en a pas — comme les
    // vraies méthodes natives.
    const prevToString = Function.prototype.toString;
    const map = new WeakMap<object, string>();
    const holder = {
      toString(this: unknown) {
        if ((typeof this === 'object' && this !== null) || typeof this === 'function') {
          if (map.has(this as object)) return map.get(this as object)!;
        }
        return prevToString.call(this as Function);
      },
    };
    const fakeToString = holder.toString;
    map.set(patchedFn as object, nativeStr);
    map.set(fakeToString, 'function toString() { [native code] }');
    Object.defineProperty(Function.prototype, 'toString', {
      value: fakeToString,
      writable: true,
      configurable: true,
    });
  }

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
  const origGetImageDataStr = origGetImageData.toString();
  // Syntaxe méthode (`{ x(){} }.x`) plutôt que `function(){}` : une fonction classique a une
  // `.prototype` propre par défaut — signal de détection distinct du `toString()`, repéré via
  // bot-detector.rebrowser.net ("nativeTampering", "has own prototype") — qu'une méthode d'objet
  // littéral n'a pas, comme les vraies méthodes natives. S'applique à toutes les fonctions
  // patchées de cette file (canvas/WebGL/audio ci-dessous).
  CanvasRenderingContext2D.prototype.getImageData = {
    getImageData(this: CanvasRenderingContext2D, ...args: Parameters<typeof origGetImageData>) {
      return noiseImageData(origGetImageData.apply(this, args));
    },
  }.getImageData;
  patchToStringNative(CanvasRenderingContext2D.prototype.getImageData, origGetImageDataStr);

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
  const origToDataURLStr = origToDataURL.toString();
  HTMLCanvasElement.prototype.toDataURL = {
    toDataURL(this: HTMLCanvasElement, ...args: unknown[]) {
      return (origToDataURL as (...a: unknown[]) => string).apply(noisyClone(this), args);
    },
  }.toDataURL;
  patchToStringNative(HTMLCanvasElement.prototype.toDataURL, origToDataURLStr);

  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  const origToBlobStr = origToBlob.toString();
  HTMLCanvasElement.prototype.toBlob = {
    toBlob(this: HTMLCanvasElement, ...args: unknown[]) {
      return (origToBlob as (...a: unknown[]) => void).apply(noisyClone(this), args);
    },
  }.toBlob;
  patchToStringNative(HTMLCanvasElement.prototype.toBlob, origToBlobStr);

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
    const origReadPixelsStr = origReadPixels.toString();
    ctor.prototype.readPixels = {
      readPixels(this: unknown, ...args: unknown[]) {
        const result = origReadPixels.apply(this, args);
        // Dernier argument = le buffer de sortie (sauf variante WebGL2 avec PBO + offset
        // numérique, ignorée ici : `noiseWebglBuffer` ne fait rien sur un nombre).
        noiseWebglBuffer(args[args.length - 1]);
        return result;
      },
    }.readPixels;
    patchToStringNative(ctor.prototype.readPixels, origReadPixelsStr);
  }
  patchReadPixels(typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext : undefined);
  patchReadPixels(typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext : undefined);

  // --- Audio : AudioBuffer.getChannelData (OfflineAudioContext + lecture d'échantillons) ---
  if (typeof AudioBuffer !== 'undefined') {
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    const origGetChannelDataStr = origGetChannelData.toString();
    AudioBuffer.prototype.getChannelData = {
      getChannelData(this: AudioBuffer, channel: number) {
        const original = origGetChannelData.call(this, channel);
        // Copie plutôt que mutation en place : l'AudioBuffer d'origine reste intact, donc chaque
        // appel repart des VRAIS échantillons + le même bruit déterministe, sans dérive
        // cumulative si la fonction est appelée plusieurs fois sur le même buffer/canal.
        const noised = new Float32Array(original.length);
        for (let i = 0; i < original.length; i++) {
          // Échelle minuscule (échantillons audio en [-1, 1]) : assez pour changer le hash,
          // jamais audible ni assez gros pour ressembler à une erreur de rendu.
          noised[i] = original[i] + pixelNoise(i) * 0.0000001;
        }
        return noised;
      },
    }.getChannelData;
    patchToStringNative(AudioBuffer.prototype.getChannelData, origGetChannelDataStr);
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
 * Découvert en testant un profil 'iPhone 15' RÉEL contre bot-detector.rebrowser.net (2026-10-26) :
 * `navigator.webdriver` vaut `true` sur WebKit dès qu'on navigue vers une vraie page — alors que
 * `healthCheck()` (cf. `build()`) le neutralise bien, mais UNIQUEMENT sur `about:blank`, la page
 * jetable où il tourne. Cette neutralisation ne survit pas à la navigation suivante : WebKit n'a
 * pas d'équivalent du flag Chromium `--disable-blink-features=AutomationControlled` (qui, lui,
 * empêche `navigator.webdriver` d'être `true` dans N'IMPORTE QUEL document, pas seulement le
 * premier), donc chaque NOUVELLE page WebKit repart avec la vraie valeur native `true`.
 *
 * Solution : enregistrer CE correctif via `context.addInitScript` (s'applique à CHAQUE nouveau
 * document, pas qu'une fois) — PAS fait jusqu'ici volontairement (cf. l'ancien commentaire sur ce
 * point, toujours vrai) car combiner un `addInitScript` ET la redéfinition de `healthCheck` dans
 * le MÊME document corrompt le getter natif (`TypeError: ... can only be used on instances of
 * Navigator` à la lecture suivante, reproductible sur iPhone ET Desktop Safari). Mais cette
 * fonction-ci ne redéfinit QUE si `navigator.webdriver === true` — une fois qu'elle a tourné (via
 * `addInitScript`, donc AVANT tout script de la page), la condition est déjà fausse quand
 * `healthCheck` lit la même page juste après : sa propre redéfinition ne se déclenche jamais, donc
 * jamais de double redéfinition. Un seul correctif réel au total, juste posé au bon endroit (CHAQUE
 * document, pas un seul jetable).
 *
 * Fonction top-level pure : son code source est sérialisé tel quel par Playwright.
 */
function hideWebdriverForWebkit(): void {
  // cf. doc identique dans `applyFingerprintNoise`/`patchHardwareConcurrencyAndWebglVendor` —
  // dupliquée ici car chaque fonction top-level enregistrée via `context.addInitScript` doit être
  // autonome. Sans ça : trouvé en testant contre bot-detector.rebrowser.net ("nativeTampering",
  // 2026-10-26) qu'un `Object.defineProperty` nu — sans masquer le `toString()` du getter qu'il
  // remplace — se détecte en comparant son `Function.prototype.toString()` au format natif attendu.
  function patchToStringNative(patchedFn: unknown, nativeStr: string): void {
    const prevToString = Function.prototype.toString;
    const map = new WeakMap<object, string>();
    const holder = {
      toString(this: unknown) {
        if ((typeof this === 'object' && this !== null) || typeof this === 'function') {
          if (map.has(this as object)) return map.get(this as object)!;
        }
        return prevToString.call(this as Function);
      },
    };
    const fakeToString = holder.toString;
    map.set(patchedFn as object, nativeStr);
    map.set(fakeToString, 'function toString() { [native code] }');
    Object.defineProperty(Function.prototype, 'toString', {
      value: fakeToString,
      writable: true,
      configurable: true,
    });
  }

  if (navigator.webdriver === true) {
    const proto = Object.getPrototypeOf(navigator);
    const origGetter = Object.getOwnPropertyDescriptor(proto, 'webdriver')?.get;
    const origGetterStr = origGetter ? origGetter.toString() : 'function get webdriver() { [native code] }';
    Object.defineProperty(proto, 'webdriver', {
      get: () => false,
      configurable: true,
      enumerable: true,
    });
    patchToStringNative(Object.getOwnPropertyDescriptor(proto, 'webdriver')!.get, origGetterStr);
  }
}

/**
 * Découvert en creusant le dernier finding restant sur les presets WebKit contre
 * bot-detector.rebrowser.net ("popupBlocking", 2026-10-26) : `window.open()` réussit depuis WebKit
 * même appelé en dehors de tout geste utilisateur (le test ouvre un popup directement depuis un
 * script, sans clic). Contrairement à Chromium (`--disable-popup-blocking`, un simple flag de
 * lancement qu'on retire déjà), aucun flag/variable d'environnement/commande du protocole distant
 * WebKit n'expose ce réglage côté Node : `webkit_settings_set_javascript_can_open_windows_
 * automatically` existe bien dans `libwebkitgtk`/`libWPEWebKit` (vérifié via `strings` sur les deux
 * libs installées), mais n'est appelé QUE par le binaire `MiniBrowser` précompilé que distribue
 * Playwright, sans aucun moyen de lui passer une valeur différente.
 *
 * `navigator.userActivation.isActive` ne peut PAS servir de signal ici : vérifié empiriquement que
 * WebKit le rapporte déjà `true` sous automatisation Playwright, même sans aucune interaction
 * réelle — c'est précisément CE qui laisse passer le popup, et une vérification basée dessus ne
 * distinguerait donc rien.
 *
 * Contournement : réimplémenter nous-mêmes la sémantique d'un vrai bloqueur de popups, au niveau
 * JS, en se basant sur `Event.isTrusted` à la place — fiable, lui : un clic réellement injecté par
 * `page.click()` (au niveau input de la plateforme, comme un vrai utilisateur) reste `isTrusted:
 * true`, alors qu'un script qui invoque `window.open()` de son propre chef n'est précédé d'AUCUN
 * évènement de ce type. On écoute les gestes capables de déclencher un popup légitime (clic,
 * relâchement de pointeur, touche, toucher) en phase de capture au niveau document, on autorise
 * `window.open` pendant une courte fenêtre après un geste `isTrusted`.
 *
 * Piège rencontré et corrigé : une première version remettait le drapeau à `false` via une
 * MICROtâche (`Promise.resolve().then(...)`), en supposant qu'elle ne s'exécuterait qu'après la
 * fin de TOUTE la distribution de l'évènement (capture + cible + bubbling). Faux — vérifié
 * empiriquement avec un clic réel sur un bouton via `page.click()` : le flag retombait à `false`
 * AVANT même que le gestionnaire `onclick` de la page n'appelle `window.open`, bloquant un vrai
 * clic légitime. Cause : la spec DOM effectue un "microtask checkpoint" après CHAQUE invocation
 * individuelle d'écouteur pendant une distribution d'évènement (étape "clean up after running
 * script"), pas seulement à la toute fin — donc une microtâche programmée dans NOTRE écouteur
 * (phase capture, document) s'exécute déjà avant que l'écouteur SUIVANT (celui du bouton, qui
 * appelle `window.open`) ne soit invoké. Un vrai `setTimeout` (macrotâche) n'a pas ce problème :
 * il attend la fin complète de la tâche en cours, distribution d'évènement incluse. Fenêtre de
 * 2 secondes : large marge pour couvrir aussi bien un `window.open` synchrone dans le gestionnaire
 * qu'un `window.open` légèrement différé après le clic (ex. `setTimeout(() => window.open(...))`,
 * motif courant sur de vrais sites), tout en restant courte pour qu'un script de page sans rapport,
 * exécuté bien après, ne profite jamais d'un geste périmé.
 *
 * Fonction top-level pure : son code source est sérialisé tel quel par Playwright.
 */
function patchPopupBlockingForWebkit(): void {
  function patchToStringNative(patchedFn: unknown, nativeStr: string): void {
    const prevToString = Function.prototype.toString;
    const map = new WeakMap<object, string>();
    const holder = {
      toString(this: unknown) {
        if ((typeof this === 'object' && this !== null) || typeof this === 'function') {
          if (map.has(this as object)) return map.get(this as object)!;
        }
        return prevToString.call(this as Function);
      },
    };
    const fakeToString = holder.toString;
    map.set(patchedFn as object, nativeStr);
    map.set(fakeToString, 'function toString() { [native code] }');
    Object.defineProperty(Function.prototype, 'toString', {
      value: fakeToString,
      writable: true,
      configurable: true,
    });
  }

  let hasRecentGesture = false;
  const gestureEvents = ['click', 'pointerup', 'keydown', 'touchend'];
  for (const type of gestureEvents) {
    document.addEventListener(
      type,
      (e) => {
        if (!e.isTrusted) return;
        hasRecentGesture = true;
        setTimeout(() => {
          hasRecentGesture = false;
        }, 2000);
      },
      true
    );
  }

  const origOpen = window.open;
  const origOpenStr = origOpen.toString();
  const wrappedOpen = {
    open(this: Window, ...args: Parameters<typeof window.open>) {
      if (!hasRecentGesture) return null; // mime un popup bloqué, comme un vrai navigateur
      return origOpen.apply(this, args);
    },
  }.open;
  window.open = wrappedOpen as typeof window.open;
  patchToStringNative(wrappedOpen, origOpenStr);
}

/**
 * Découvert en testant les presets 'Pixel 7' ET 'iPhone 15' RÉELS contre
 * bot-detector.rebrowser.net (2026-10-26) : `navigator.maxTouchPoints` ne correspond jamais à un
 * vrai téléphone sur aucun des deux moteurs.
 *   - Chromium : vaut 1, la valeur par défaut de l'émulation tactile CDP (`Emulation.
 *     setTouchEmulationEnabled`) que Playwright pose pour tout device `hasTouch: true` — un vrai
 *     téléphone Android rapporte 5 (support multi-touch).
 *   - WebKit : vaut carrément 0 (aucun support tactile signalé du tout), alors que l'UA annonce un
 *     UA mobile — l'outil le signale explicitement comme incohérent ("Mobile user agent without
 *     any touch support"). Un vrai iPhone Safari rapporte aussi 5.
 * Appliquée uniquement pour les devices avec `hasTouch: true` (presets mobiles) — jamais pour
 * 'desktop', dont le vrai 0 est correct et ne doit pas être touché.
 *
 * Fonction top-level pure : son code source est sérialisé tel quel par Playwright.
 */
function patchMaxTouchPoints(points: number): void {
  // cf. doc de `patchToStringNative` dans `hideWebdriverForWebkit` juste au-dessus — même
  // raisonnement, dupliqué pour la même raison d'autonomie des fonctions `addInitScript`.
  function patchToStringNative(patchedFn: unknown, nativeStr: string): void {
    const prevToString = Function.prototype.toString;
    const map = new WeakMap<object, string>();
    const holder = {
      toString(this: unknown) {
        if ((typeof this === 'object' && this !== null) || typeof this === 'function') {
          if (map.has(this as object)) return map.get(this as object)!;
        }
        return prevToString.call(this as Function);
      },
    };
    const fakeToString = holder.toString;
    map.set(patchedFn as object, nativeStr);
    map.set(fakeToString, 'function toString() { [native code] }');
    Object.defineProperty(Function.prototype, 'toString', {
      value: fakeToString,
      writable: true,
      configurable: true,
    });
  }

  const proto = Object.getPrototypeOf(navigator);
  const origGetter = Object.getOwnPropertyDescriptor(proto, 'maxTouchPoints')?.get;
  const origGetterStr = origGetter ? origGetter.toString() : 'function get maxTouchPoints() { [native code] }';
  Object.defineProperty(proto, 'maxTouchPoints', {
    get: () => points,
    configurable: true,
    enumerable: true,
  });
  patchToStringNative(Object.getOwnPropertyDescriptor(proto, 'maxTouchPoints')!.get, origGetterStr);
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

type PlatformCategory = 'windows' | 'macos' | 'linux' | 'android' | 'ios';

/**
 * Découvert via bot-detector.rebrowser.net ("platformMismatch") : un profil 'desktop' qui prétend
 * "Windows" en dur, peu importe le vrai système hôte, se trahit sur un host Linux/macOS via la
 * couleur CSS système `ActiveText` — résolue par le moteur natif de Chromium (`NativeTheme`, en
 * C++), qui interroge le VRAI thème de l'OS, hors de portée de tout override JS (`navigator.
 * platform`, Client Hints...). Sur Linux ET macOS, Chrome retombe sur une palette intégrée fixe
 * (rouge pur) pour `ActiveText` ; seul un Chrome qui tourne VRAIMENT sous Windows obtient la vraie
 * couleur "hotlight" via l'API Windows. Donc : claim le système qu'on simule, jamais un autre —
 * testé et confirmé (2026-10-26) qu'un profil qui claim honnêtement son host réel fait passer ce
 * test au vert.
 */
export function detectHostPlatformCategory(): 'windows' | 'macos' | 'linux' {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      return 'linux';
  }
}

/**
 * Déduit la plateforme à simuler — pour le fingerprint de polices (`FONT_WHITELISTS`), mais
 * aussi `navigator.platform`/Client Hints ci-dessous — à partir de ce qu'on sait déjà du device :
 * `engine` (chromium routé côté desktop/Android, webkit côté macOS/iOS) et `isMobile` (desktop vs
 * mobile pour ce même moteur). Les presets mobiles/webkit restent des émulations figées (choisies
 * explicitement par leur nom dans le dashboard, ex. 'iPhone 15') — aucune machine ne tourne
 * vraiment sous iOS/Android ici, donc rien à détecter pour eux. Seul le desktop Chromium varie
 * réellement d'une machine à l'autre : cf. doc de `detectHostPlatformCategory`.
 */
function choosePlatformCategory(engine: Engine, isMobile: boolean | undefined): PlatformCategory {
  if (engine === 'webkit') {
    return isMobile ? 'ios' : 'macos';
  }
  if (isMobile) return 'android';
  return detectHostPlatformCategory();
}

// Valeur de `navigator.platform` par plateforme. Note : "Win32" pour Windows n'est pas une
// erreur — même un vrai Chrome 64 bits sur Windows 10/11 rapporte "Win32" pour compat web, un
// comportement stable depuis des années.
const PLATFORM_STRINGS: Record<PlatformCategory, string> = {
  windows: 'Win32',
  macos: 'MacIntel',
  // Confirmé empiriquement (profil sans aucun override, cf. doc de `detectHostPlatformCategory`) :
  // un vrai Chrome Linux x86_64 rapporte exactement cette valeur, pas "Linux i686" ni autre.
  linux: 'Linux x86_64',
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
  // cf. doc identique dans `applyFingerprintNoise`.
  function patchToStringNative(patchedFn: unknown, nativeStr: string): void {
    // Découvert via bot-detector.rebrowser.net ("nativeTampering") : un `new Proxy(...)` sur
    // `Function.prototype.toString` se détecte STRUCTURELLEMENT (ex. test de cycle sur
    // `__proto__`), indépendamment de ce que le piège `apply` renvoie — masquer le CONTENU du
    // `toString()` ne suffit pas si l'objet lui-même reste un Proxy repérable. On utilise donc
    // une fonction normale fermée sur une `WeakMap` plutôt qu'un Proxy : chaque appel de
    // `patchToStringNative` chaîne un nouveau remplaçant (fonction normale, pas Proxy) par-dessus
    // le précédent `Function.prototype.toString` (qui, après le tout premier appel, n'est déjà
    // plus un Proxy lui non plus), avec repli vers lui pour toute fonction non enregistrée.
    // Syntaxe méthode (`toString(){}` dans un littéral objet) plutôt que `function(){}` : une
    // fonction normale a une `.prototype` propre par défaut (signal de détection distinct, repéré
    // sur `HTMLCanvasElement.toDataURL` via le même outil), une méthode n'en a pas — comme les
    // vraies méthodes natives.
    const prevToString = Function.prototype.toString;
    const map = new WeakMap<object, string>();
    const holder = {
      toString(this: unknown) {
        if ((typeof this === 'object' && this !== null) || typeof this === 'function') {
          if (map.has(this as object)) return map.get(this as object)!;
        }
        return prevToString.call(this as Function);
      },
    };
    const fakeToString = holder.toString;
    map.set(patchedFn as object, nativeStr);
    map.set(fakeToString, 'function toString() { [native code] }');
    Object.defineProperty(Function.prototype, 'toString', {
      value: fakeToString,
      writable: true,
      configurable: true,
    });
  }

  const proto = Object.getPrototypeOf(navigator);
  const origPlatformGetter = Object.getOwnPropertyDescriptor(proto, 'platform')?.get;
  const origPlatformGetterStr = origPlatformGetter ? origPlatformGetter.toString() : 'function platform() { [native code] }';
  Object.defineProperty(proto, 'platform', {
    get: () => values.platform,
    configurable: true,
    enumerable: true,
  });
  patchToStringNative(Object.getOwnPropertyDescriptor(proto, 'platform')!.get, origPlatformGetterStr);

  const origLanguagesGetter = Object.getOwnPropertyDescriptor(proto, 'languages')?.get;
  const origLanguagesGetterStr = origLanguagesGetter ? origLanguagesGetter.toString() : 'function languages() { [native code] }';
  const frozenLanguages = Object.freeze(values.languages.slice());
  Object.defineProperty(proto, 'languages', {
    get: () => frozenLanguages,
    configurable: true,
    enumerable: true,
  });
  patchToStringNative(Object.getOwnPropertyDescriptor(proto, 'languages')!.get, origLanguagesGetterStr);
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
  // `platformVersion` vide : Chromium n'a pas de notion de "version d'OS" exploitable sur Linux
  // (contrairement à Windows/macOS/Android) — un vrai Chrome Linux envoie une chaîne vide sur
  // `Sec-CH-UA-Platform-Version`. La remplir avec une fausse valeur serait l'incohérence inverse.
  linux: { platform: 'Linux', mobile: false, platformVersion: '', architecture: 'x86' },
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
  // cf. doc identique dans `applyFingerprintNoise`.
  function patchToStringNative(patchedFn: unknown, nativeStr: string): void {
    // Découvert via bot-detector.rebrowser.net ("nativeTampering") : un `new Proxy(...)` sur
    // `Function.prototype.toString` se détecte STRUCTURELLEMENT (ex. test de cycle sur
    // `__proto__`), indépendamment de ce que le piège `apply` renvoie — masquer le CONTENU du
    // `toString()` ne suffit pas si l'objet lui-même reste un Proxy repérable. On utilise donc
    // une fonction normale fermée sur une `WeakMap` plutôt qu'un Proxy : chaque appel de
    // `patchToStringNative` chaîne un nouveau remplaçant (fonction normale, pas Proxy) par-dessus
    // le précédent `Function.prototype.toString` (qui, après le tout premier appel, n'est déjà
    // plus un Proxy lui non plus), avec repli vers lui pour toute fonction non enregistrée.
    // Syntaxe méthode (`toString(){}` dans un littéral objet) plutôt que `function(){}` : une
    // fonction normale a une `.prototype` propre par défaut (signal de détection distinct, repéré
    // sur `HTMLCanvasElement.toDataURL` via le même outil), une méthode n'en a pas — comme les
    // vraies méthodes natives.
    const prevToString = Function.prototype.toString;
    const map = new WeakMap<object, string>();
    const holder = {
      toString(this: unknown) {
        if ((typeof this === 'object' && this !== null) || typeof this === 'function') {
          if (map.has(this as object)) return map.get(this as object)!;
        }
        return prevToString.call(this as Function);
      },
    };
    const fakeToString = holder.toString;
    map.set(patchedFn as object, nativeStr);
    map.set(fakeToString, 'function toString() { [native code] }');
    Object.defineProperty(Function.prototype, 'toString', {
      value: fakeToString,
      writable: true,
      configurable: true,
    });
  }

  if (!('userAgentData' in navigator)) return; // moteur sans Client Hints (webkit) : rien à faire
  const origUaDataGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'userAgentData')?.get;
  const origUaDataGetterStr = origUaDataGetter ? origUaDataGetter.toString() : 'function userAgentData() { [native code] }';
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
  patchToStringNative(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'userAgentData')!.get, origUaDataGetterStr);
  patchToStringNative(uaData.toJSON, 'function toJSON() { [native code] }');
  patchToStringNative(uaData.getHighEntropyValues, 'function getHighEntropyValues() { [native code] }');

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
/**
 * Remplace l'évasion `window.outerdimensions` du plugin stealth tiers (retiré, cf. commentaire
 * au-dessus de `CHROMIUM_STEALTH_EVASIONS`/`GENERIC_STEALTH_EVASIONS` plus bas) : en mode
 * headless, `window.outerWidth`/`outerHeight` valent 0 (pas de vraie fenêtre système), alors
 * qu'un navigateur headED a toujours des dimensions externes non nulles (= dimensions internes +
 * le cadre de la fenêtre). Un script de fingerprint qui compare les deux (ex. CreepJS) détecte le
 * mode headless par cette simple absence. Pas un `new Proxy(...)` : `window.outerWidth/outerHeight`
 * sont déjà des propriétés normales (pas des accesseurs sur le prototype comme `navigator.*`),
 * une simple affectation directe suffit, aucune forme de masquage `toString` nécessaire.
 *
 * Fonction top-level pure : son code source est sérialisé tel quel par Playwright.
 */
function patchWindowOuterDimensions(): void {
  try {
    if (window.outerWidth && window.outerHeight) return;
    const windowFrame = 85; // cadre de fenêtre typique (barre de titre/bordures), dépend de l'OS/WM
    (window as unknown as { outerWidth: number }).outerWidth = window.innerWidth;
    (window as unknown as { outerHeight: number }).outerHeight = window.innerHeight + windowFrame;
  } catch {
    // best-effort : jamais fatal pour le reste du build.
  }
}

function patchWorkerFingerprint(): void {
  // cf. doc identique dans `applyFingerprintNoise`.
  function patchToStringNative(patchedFn: unknown, nativeStr: string): void {
    // Découvert via bot-detector.rebrowser.net ("nativeTampering") : un `new Proxy(...)` sur
    // `Function.prototype.toString` se détecte STRUCTURELLEMENT (ex. test de cycle sur
    // `__proto__`), indépendamment de ce que le piège `apply` renvoie — masquer le CONTENU du
    // `toString()` ne suffit pas si l'objet lui-même reste un Proxy repérable. On utilise donc
    // une fonction normale fermée sur une `WeakMap` plutôt qu'un Proxy : chaque appel de
    // `patchToStringNative` chaîne un nouveau remplaçant (fonction normale, pas Proxy) par-dessus
    // le précédent `Function.prototype.toString` (qui, après le tout premier appel, n'est déjà
    // plus un Proxy lui non plus), avec repli vers lui pour toute fonction non enregistrée.
    // Syntaxe méthode (`toString(){}` dans un littéral objet) plutôt que `function(){}` : une
    // fonction normale a une `.prototype` propre par défaut (signal de détection distinct, repéré
    // sur `HTMLCanvasElement.toDataURL` via le même outil), une méthode n'en a pas — comme les
    // vraies méthodes natives.
    const prevToString = Function.prototype.toString;
    const map = new WeakMap<object, string>();
    const holder = {
      toString(this: unknown) {
        if ((typeof this === 'object' && this !== null) || typeof this === 'function') {
          if (map.has(this as object)) return map.get(this as object)!;
        }
        return prevToString.call(this as Function);
      },
    };
    const fakeToString = holder.toString;
    map.set(patchedFn as object, nativeStr);
    map.set(fakeToString, 'function toString() { [native code] }');
    Object.defineProperty(Function.prototype, 'toString', {
      value: fakeToString,
      writable: true,
      configurable: true,
    });
  }

  // Un Worker a sa PROPRE portée globale (`self`), donc son propre `Function.prototype.toString`
  // à patcher séparément du thread principal (`patchToStringNative` ci-dessus ne s'y applique
  // pas) — ce texte est injecté tel quel en tête du bootstrap du worker. `__pts` capture et
  // réutilise le VRAI `toString()` natif du getter qu'il remplace, lu au moment de l'exécution
  // À L'INTÉRIEUR du worker plutôt que figé depuis le thread principal.
  // cf. doc de `patchToStringNative` (thread principal) : même raisonnement, un `new Proxy(...)`
  // sur `Function.prototype.toString` se détecte structurellement (indépendamment de ce qu'il
  // renvoie), donc on utilise ici aussi une fonction normale fermée sur une `WeakMap` — et la
  // syntaxe méthode (`toString(){}`) pour que ce remplaçant n'ait pas, lui non plus, de
  // `.prototype` propre (contrairement à une fonction classique `function(){}`).
  const workerToStringPatcher =
    "(function(){var p=Function.prototype.toString;var m=new WeakMap();" +
    "var h={toString(){if((typeof this==='object'&&this!==null)||typeof this==='function'){" +
    "if(m.has(this))return m.get(this);}return p.call(this);}};var f=h.toString;" +
    "m.set(f,'function toString() { [native code] }');" +
    "Object.defineProperty(Function.prototype,'toString',{value:f,writable:true,configurable:true});" +
    "self.__pts=function(fn,str){m.set(fn,str);};})();";
  function workerPropPatch(propName: string, valueLiteral: string): string {
    return (
      `(function(){var d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator),'${propName}');` +
      `var o=d&&d.get?d.get.toString():'function ${propName}() { [native code] }';` +
      `Object.defineProperty(Object.getPrototypeOf(navigator),'${propName}',{get:function(){return ${valueLiteral};},configurable:true});` +
      `__pts(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator),'${propName}').get,o);})();`
    );
  }

  const patchParts = [
    workerToStringPatcher,
    workerPropPatch('userAgent', JSON.stringify(navigator.userAgent)),
    workerPropPatch('platform', JSON.stringify(navigator.platform)),
    workerPropPatch('hardwareConcurrency', String(navigator.hardwareConcurrency)),
    // Découvert via bot-detector.rebrowser.net ("workerConsistency") : `navigator.languages`
    // manquait ici, donc un Worker rapportait `["fr"]` (sa propre valeur par défaut) au lieu de
    // `["fr-FR","fr"]` comme le thread principal — repéré par comparaison directe main vs worker,
    // pas par un test de masquage.
    workerPropPatch('languages', JSON.stringify(navigator.languages)),
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
        "var d2=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator),'userAgentData');" +
        "var o2=d2&&d2.get?d2.get.toString():'function userAgentData() { [native code] }';" +
        "Object.defineProperty(Object.getPrototypeOf(navigator),'userAgentData',{get:function(){return uaData;},configurable:true});" +
        "__pts(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator),'userAgentData').get,o2);" +
        "__pts(uaData.toJSON,'function toJSON() { [native code] }');" +
        "__pts(uaData.getHighEntropyValues,'function getHighEntropyValues() { [native code] }');" +
        '})();'
    );
  }

  const patchSource = patchParts.join('\n');

  function wrap(OriginalCtor: any): any {
    const originalCtorStr = OriginalCtor.toString();
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
    // `.name` et `.toString()` doivent matcher le VRAI constructeur (`Worker`/`SharedWorker`) —
    // sinon `window.Worker.name` ("Patched" au lieu de "Worker") ou son `toString()` (notre
    // propre code source au lieu de "[native code]") trahiraient le remplacement à l'inspection.
    Object.defineProperty(Patched, 'name', { value: OriginalCtor.name, configurable: true });
    patchToStringNative(Patched, originalCtorStr);
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
    "var d2=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator),'userAgentData');" +
    "var o2=d2&&d2.get?d2.get.toString():'function userAgentData() { [native code] }';" +
    "Object.defineProperty(Object.getPrototypeOf(navigator),'userAgentData',{get:function(){return uaData;},configurable:true});" +
    "if (typeof __pts === 'function') {" +
    "__pts(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator),'userAgentData').get,o2);" +
    "__pts(uaData.toJSON,'function toJSON() { [native code] }');" +
    "__pts(uaData.getHighEntropyValues,'function getHighEntropyValues() { [native code] }');" +
    '}' +
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
 * Trois techniques essayées, deux écartées, l'historique compte pour ne pas les retenter :
 *   1. `context.route()` + `route.continue({headers})` : ÉCHEC vérifié empiriquement sur
 *      tls.peet.ws — Chromium réinjecte sa propre valeur de `Sec-CH-UA` APRÈS l'interception
 *      `Fetch` sur une requête de navigation, quel que soit ce qu'on lui passe.
 *   2. `context.setExtraHTTPHeaders()` : fonctionne pour une navigation DIRECTE (vérifié sur
 *      tls.peet.ws et sur un serveur local), mais ÉCHOUE si cette navigation subit une
 *      redirection HTTP côté serveur — vérifié empiriquement en reproduisant EXACTEMENT le cas
 *      rencontré sur x.com (login → redirection 302 vers leur endpoint de vérification anti-bot
 *      `/i/jf/onboarding/web`, qui répond 403) : Chromium recalcule `Sec-CH-UA` à neuf sur la
 *      destination d'une redirection, en ignorant l'override `setExtraHTTPHeaders` posé sur la
 *      requête d'origine. Une variante avec `route.fetch({headers})+route.fulfill()` (qui suit la
 *      redirection lui-même) CORRIGE bien l'en-tête, mais a été écartée après vérification : elle
 *      remplace la vraie pile réseau du navigateur par celle de Playwright pour cette requête,
 *      changeant complètement l'empreinte TLS/JA3/JA4 (vérifié sur tls.peet.ws : hash JA3
 *      totalement différent, `h2` absent de la négociation ALPN) — un signal de détection bien
 *      plus grave que celui qu'on cherche à corriger. Perdre la vraie pile TLS de Chromium sur
 *      une requête de NAVIGATION (potentiellement le document principal) n'est pas un compromis
 *      acceptable pour corriger un simple en-tête.
 *   3. `Network.setUserAgentOverride` via une session CDP brute (`context.newCDPSession`), avec
 *      son paramètre `userAgentMetadata` — RETENUE : vérifié empiriquement sur le même scénario de
 *      redirection reproduit localement que `Sec-CH-UA` ET `User-Agent` survivent tous les deux
 *      correctement à la redirection, que `page.url()` reflète bien la destination finale (le
 *      navigateur suit lui-même la redirection, rien n'est intercepté/reconstruit), et que la vraie
 *      pile réseau/TLS de Chromium reste utilisée de bout en bout (ce n'est qu'une préférence
 *      interne, pas une requête de remplacement). C'est très probablement le MÊME mécanisme que
 *      Playwright utilise déjà en interne pour son option `userAgent` de contexte (qui, elle,
 *      survit déjà à cette redirection sans rien faire de spécial) — on lui fournit juste le
 *      `userAgentMetadata` qu'elle ne renseigne pas.
 *
 * On ne fixe QUE les champs correspondant à `Sec-CH-UA` (brands/fullVersion, confirmés fuyants) ;
 * les champs haute-entropie (platformVersion/architecture/model/bitness/wow64) sont renseignés
 * avec les mêmes valeurs que `CLIENT_HINTS_BY_PLATFORM`/`applyClientHintsOverride` par cohérence,
 * mais rappel : ils ne sont exposés en HTTP que si le serveur les a demandés via `Accept-CH`.
 */
function buildUserAgentMetadata(ua: string, profile: ClientHintsProfile) {
  const uaMatch = ua.match(/Chrome\/([\d.]+)/);
  const fullVersion = uaMatch ? uaMatch[1] : '120.0.0.0';
  const majorVersion = fullVersion.split('.')[0];
  return {
    brands: [
      { brand: 'Not_A Brand', version: '8' },
      { brand: 'Chromium', version: majorVersion },
      { brand: 'Google Chrome', version: majorVersion },
    ],
    fullVersionList: [
      { brand: 'Not_A Brand', version: '8.0.0.0' },
      { brand: 'Chromium', version: fullVersion },
      { brand: 'Google Chrome', version: fullVersion },
    ],
    fullVersion,
    platform: profile.platform,
    platformVersion: profile.platformVersion,
    architecture: profile.architecture,
    model: '',
    mobile: profile.mobile,
    bitness: '64',
    wow64: false,
  };
}

/**
 * Applique `buildUserAgentMetadata` via CDP à une page donnée (cf. doc ci-dessus, technique n°3) :
 * factorisée pour être appelée à la fois sur la page initiale et sur toute page future ouverte
 * dans le même contexte (popup/nouvel onglet), une session CDP n'étant pas automatiquement
 * héritée par les nouvelles pages contrairement à `context.addInitScript`.
 */
async function applyClientHintsCdpOverride(context: BrowserContext, page: Page, profile: ClientHintsProfile): Promise<void> {
  // `'chromium'` en dur : cette fonction n'est appelée par `build()` QUE côté Chromium
  // (`clientHintsProfile` vaut `null` sur webkit, cf. son appelant) — les Client Hints n'existent
  // pas sur WebKit.
  const ua = await mainWorldEvaluate(page, () => navigator.userAgent, 'chromium');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.setUserAgentOverride', {
    userAgent: ua,
    userAgentMetadata: buildUserAgentMetadata(ua, profile),
  });
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
  clientHintsProfile: ClientHintsProfile | null,
  engine: Engine
): Promise<void> {
  const pageFp = await mainWorldEvaluate(
    page,
    () => ({
      ua: navigator.userAgent,
      platform: navigator.platform,
      languages: navigator.languages,
    }),
    engine
  );
  // `cores` vient directement de `SPOOFED_HARDWARE_CONCURRENCY` (la même constante Node que
  // `patchHardwareConcurrencyAndWebglVendor` applique à la page) plutôt que d'une lecture de
  // `navigator.hardwareConcurrency` sur la page : vérifié empiriquement que cette lecture arrivait
  // parfois AVANT que cette fonction n'ait eu la chance de s'appliquer sur `about:blank`, lisant
  // encore la vraie valeur hôte — cf. doc de la constante.
  const fp = { ...pageFp, cores: SPOOFED_HARDWARE_CONCURRENCY };

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
      // Découvert en diagnostiquant une page YouTube réelle qui restait blanche (vidéo/audio
      // natifs jouaient, mais AUCUNE UI ne s'affichait, 2026-10-26) : un vrai Service Worker de
      // production (précaching type Workbox) ne charge pas QUE son propre script — il fait aussi
      // des `fetch()` internes pour mettre en cache des CSS/images/JSON/polices, etc.
      // `request.serviceWorker()` est non-null pour TOUTES ces requêtes, pas seulement le script
      // JS du Service Worker lui-même. Sans ce garde-fou, on préfixait du JS devant N'IMPORTE
      // QUELLE ressource récupérée par le Service Worker, y compris du CSS/JSON/images — les
      // corrompant silencieusement (un CSS avec du JS collé devant n'est plus un CSS valide).
      // Seules les réponses dont le Content-Type annonce vraiment du JavaScript sont concernées.
      const contentType = response.headers()['content-type'] || '';
      if (!/javascript|ecmascript/i.test(contentType)) {
        await route.fulfill({ response });
        return;
      }
      const body = await response.text();
      // cf. doc de `patchWorkerFingerprint` : un Service Worker a lui aussi sa propre portée
      // globale, donc son propre `Function.prototype.toString` à patcher séparément. Même
      // technique WeakMap + méthode plutôt que Proxy (cf. doc de `patchToStringNative`, thread
      // principal) : un `new Proxy(...)` sur `Function.prototype.toString` se détecte
      // structurellement, indépendamment de ce qu'il renvoie.
      const workerToStringPatcher =
        "(function(){var p=Function.prototype.toString;var m=new WeakMap();" +
        "var h={toString(){if((typeof this==='object'&&this!==null)||typeof this==='function'){" +
        "if(m.has(this))return m.get(this);}return p.call(this);}};var f=h.toString;" +
        "m.set(f,'function toString() { [native code] }');" +
        "Object.defineProperty(Function.prototype,'toString',{value:f,writable:true,configurable:true});" +
        "self.__pts=function(fn,str){m.set(fn,str);};})();";
      function swPropPatch(propName: string, valueLiteral: string): string {
        return (
          `(function(){var d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator),'${propName}');` +
          `var o=d&&d.get?d.get.toString():'function ${propName}() { [native code] }';` +
          `Object.defineProperty(Object.getPrototypeOf(navigator),'${propName}',{get:function(){return ${valueLiteral};},configurable:true});` +
          `__pts(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator),'${propName}').get,o);})();`
        );
      }
      const patchParts = [
        workerToStringPatcher,
        swPropPatch('userAgent', JSON.stringify(fp.ua)),
        swPropPatch('platform', JSON.stringify(fp.platform)),
        swPropPatch('hardwareConcurrency', String(fp.cores)),
        swPropPatch('languages', JSON.stringify(fp.languages)),
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
  // Polices génériques les plus répandues toutes distros confondues (pas spécifiques à Kali) :
  // Liberation (alias métriquement compatibles Arial/Times/Courier, préinstallées sur
  // Fedora/RHEL et la plupart des distros), DejaVu (quasi universelle, défaut historique de X11),
  // Noto (fallback Unicode large de Google, très largement packagé), Cantarell (police GNOME par
  // défaut), Ubuntu (défaut sur les dérivées Ubuntu). Vérifié via `fc-list` sur cette machine que
  // Liberation/DejaVu/Noto/Cantarell y sont bien réellement installées.
  linux: [
    'DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif', 'Liberation Sans', 'Liberation Sans Narrow',
    'Liberation Serif', 'Liberation Mono', 'Noto Sans', 'Noto Serif', 'Noto Sans Mono',
    'Noto Color Emoji', 'Cantarell', 'Ubuntu', 'Ubuntu Mono', 'FreeSans', 'FreeSerif', 'FreeMono',
    'Droid Sans Fallback',
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
  // cf. doc identique dans `applyFingerprintNoise` — dupliquée ici car chaque fonction
  // top-level enregistrée via `context.addInitScript` doit être autonome (son code source est
  // sérialisé tel quel, sans accès aux autres fonctions top-level du fichier).
  function patchToStringNative(patchedFn: unknown, nativeStr: string): void {
    // Découvert via bot-detector.rebrowser.net ("nativeTampering") : un `new Proxy(...)` sur
    // `Function.prototype.toString` se détecte STRUCTURELLEMENT (ex. test de cycle sur
    // `__proto__`), indépendamment de ce que le piège `apply` renvoie — masquer le CONTENU du
    // `toString()` ne suffit pas si l'objet lui-même reste un Proxy repérable. On utilise donc
    // une fonction normale fermée sur une `WeakMap` plutôt qu'un Proxy : chaque appel de
    // `patchToStringNative` chaîne un nouveau remplaçant (fonction normale, pas Proxy) par-dessus
    // le précédent `Function.prototype.toString` (qui, après le tout premier appel, n'est déjà
    // plus un Proxy lui non plus), avec repli vers lui pour toute fonction non enregistrée.
    // Syntaxe méthode (`toString(){}` dans un littéral objet) plutôt que `function(){}` : une
    // fonction normale a une `.prototype` propre par défaut (signal de détection distinct, repéré
    // sur `HTMLCanvasElement.toDataURL` via le même outil), une méthode n'en a pas — comme les
    // vraies méthodes natives.
    const prevToString = Function.prototype.toString;
    const map = new WeakMap<object, string>();
    const holder = {
      toString(this: unknown) {
        if ((typeof this === 'object' && this !== null) || typeof this === 'function') {
          if (map.has(this as object)) return map.get(this as object)!;
        }
        return prevToString.call(this as Function);
      },
    };
    const fakeToString = holder.toString;
    map.set(patchedFn as object, nativeStr);
    map.set(fakeToString, 'function toString() { [native code] }');
    Object.defineProperty(Function.prototype, 'toString', {
      value: fakeToString,
      writable: true,
      configurable: true,
    });
  }

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
  const origMeasureTextStr = origMeasureText.toString();
  CanvasRenderingContext2D.prototype.measureText = {
    measureText(this: CanvasRenderingContext2D, text: string) {
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
    },
  }.measureText;
  patchToStringNative(CanvasRenderingContext2D.prototype.measureText, origMeasureTextStr);

  const fontsSet = (document as any).fonts;
  if (fontsSet && typeof fontsSet.check === 'function') {
    const origCheck = fontsSet.check.bind(fontsSet);
    // `document.fonts.check` est une propriété d'INSTANCE (pas `FontFaceSet.prototype.check`,
    // qui reste intact et natif) — capturer son `toString()` avant écrasement reste la bonne
    // approche, juste sur cet objet précis plutôt que sur un prototype partagé.
    const origCheckStr = fontsSet.check.toString();
    fontsSet.check = function (fontCss: string, text?: string) {
      const requested = parseFamilies(fontCss)[0];
      if (requested && !isAllowed(requested)) {
        return false;
      }
      return origCheck(fontCss, text);
    };
    patchToStringNative(fontsSet.check, origCheckStr);
  }
}

// Valeur de `navigator.hardwareConcurrency` posée par `patchHardwareConcurrencyAndWebglVendor`
// ci-dessous — même défaut que l'évasion du plugin stealth qu'elle remplace. Exposée en
// constante Node (pas juste un littéral dans la fonction sérialisée) pour que
// `patchServiceWorkerFingerprint`, plus bas, puisse réutiliser la MÊME valeur directement plutôt
// que de la relire sur `navigator.hardwareConcurrency` depuis Node — vérifié empiriquement que
// cette lecture arrive parfois AVANT que cette fonction n'ait eu la chance de s'appliquer sur la
// page encore vierge (`about:blank`), une course différente de celle déjà documentée ailleurs
// dans ce fichier pour `__stealthClientHints`, mais de la même famille.
const SPOOFED_HARDWARE_CONCURRENCY = 4;

/**
 * Réimplémente nous-mêmes DEUX évasions du plugin stealth tiers — `navigator.hardwareConcurrency`
 * et `webgl.vendor` — découvert via bot-detector.rebrowser.net ("nativeTampering") : leurs
 * versions internes enveloppent les fonctions patchées dans un VRAI `new Proxy(...)`
 * (`utils.replaceGetterWithProxy`/`utils.replaceWithProxy`), détectable structurellement (test de
 * cycle sur `__proto__`) INDÉPENDAMMENT de ce que `toString()` renvoie — notre propre
 * `patchToStringNative` (basé sur une fonction normale + `WeakMap`, jamais un Proxy) ne peut rien
 * y faire puisque le problème n'est pas le contenu du `toString()`, c'est la nature structurelle
 * de l'objet lui-même. Seule option : ne pas utiliser ces deux évasions du plugin (exclues plus
 * bas de `CHROMIUM_STEALTH_EVASIONS`) et les reproduire ici avec nos propres fonctions normales
 * (syntaxe méthode, jamais de Proxy), mêmes valeurs par défaut que le plugin pour ne rien changer
 * d'observable : `hardwareConcurrency` (cf. `SPOOFED_HARDWARE_CONCURRENCY`), vendor
 * `"Intel Inc."`, renderer `"Intel Iris OpenGL Engine"` (cf.
 * `node_modules/puppeteer-extra-plugin-stealth/evasions/navigator.hardwareConcurrency` et
 * `.../webgl.vendor`).
 *
 * Fonction top-level pure : son code source est sérialisé tel quel par Playwright.
 */
function patchHardwareConcurrencyAndWebglVendor(hardwareConcurrency: number): void {
  function patchToStringNative(patchedFn: unknown, nativeStr: string): void {
    const prevToString = Function.prototype.toString;
    const map = new WeakMap<object, string>();
    const holder = {
      toString(this: unknown) {
        if ((typeof this === 'object' && this !== null) || typeof this === 'function') {
          if (map.has(this as object)) return map.get(this as object)!;
        }
        return prevToString.call(this as Function);
      },
    };
    const fakeToString = holder.toString;
    map.set(patchedFn as object, nativeStr);
    map.set(fakeToString, 'function toString() { [native code] }');
    Object.defineProperty(Function.prototype, 'toString', {
      value: fakeToString,
      writable: true,
      configurable: true,
    });
  }

  const proto = Object.getPrototypeOf(navigator);
  const origHwcGetter = Object.getOwnPropertyDescriptor(proto, 'hardwareConcurrency')?.get;
  const origHwcGetterStr = origHwcGetter ? origHwcGetter.toString() : 'function hardwareConcurrency() { [native code] }';
  Object.defineProperty(proto, 'hardwareConcurrency', {
    get: { hardwareConcurrency: () => hardwareConcurrency }.hardwareConcurrency,
    configurable: true,
    enumerable: true,
  });
  patchToStringNative(Object.getOwnPropertyDescriptor(proto, 'hardwareConcurrency')!.get, origHwcGetterStr);

  function patchGetParameter(ctor: { prototype: Record<string, any> } | undefined): void {
    if (!ctor) return;
    const origGetParameter = ctor.prototype.getParameter;
    const origGetParameterStr = origGetParameter.toString();
    ctor.prototype.getParameter = {
      getParameter(this: unknown, param: number) {
        if (param === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
        if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
        return origGetParameter.call(this, param);
      },
    }.getParameter;
    patchToStringNative(ctor.prototype.getParameter, origGetParameterStr);
  }
  patchGetParameter(typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext : undefined);
  patchGetParameter(typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext : undefined);
}

// `puppeteer-extra-plugin-stealth` (et `playwright-extra`) ont été retirés du projet : découvert
// via bot-detector.rebrowser.net ("nativeTampering") que son évasion `iframe.contentWindow` est
// désormais reconnue NOMMÉMENT par cet outil ("That's the iframe.contentWindow evasion of
// puppeteer-extra-plugin-stealth") — ce n'est plus un correctif discret, c'est une signature.
// Plusieurs autres évasions du plugin (`navigator.permissions`, `media.codecs`, déjà exclues
// avant côté `navigator.hardwareConcurrency`/`webgl.vendor`) s'appuient aussi sur
// `new Proxy(...)` en interne, détectable structurellement pour la même raison documentée sur
// `patchHardwareConcurrencyAndWebglVendor`. Plutôt que de patcher autour de ces fuites une à une,
// on s'appuie désormais sur le fait que Chromium est lancé via `channel: 'chrome'` (vrai Google
// Chrome installé, pas un Chromium nu) : la plupart des artefacts que le plugin fabriquait
// (`window.chrome.app/runtime/csi/loadTimes`, `navigator.plugins`, support des codecs
// propriétaires) sont déjà NATIVEMENT présents sur un vrai Chrome, pas besoin de les imiter.
// Seule exception identifiée nécessitant un correctif de remplacement :
// `window.outerWidth`/`outerHeight`, vides en mode headless sur les deux moteurs — cf.
// `patchWindowOuterDimensions` plus bas (réimplémentation sans Proxy).
// `navigator.webdriver` reste traité à part dans `build()`/`healthCheck()`, inchangé.

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

// Liste EXACTE du `--disable-features=...` que Playwright pose par défaut sur le Chromium qu'il
// lance, lue directement sur la ligne de commande du process réellement démarré (`/proc/<pid>/
// cmdline`) — aucune autre source fiable pour cette chaîne (construite dynamiquement en interne,
// jamais exposée telle quelle par l'API publique). Utilisée dans `build()` pour retirer ce
// `--disable-features=...` par défaut via `ignoreDefaultArgs` (nécessite une correspondance EXACTE
// de la chaîne) et le reposer nous-mêmes sans `ThirdPartyStoragePartitioning` (cf. doc sur
// l'appel à `launchPersistentContext`). Fragile par construction : si une future version de
// Playwright change cette liste, `ignoreDefaultArgs` ne matchera plus et ce `--disable-features=`
// par défaut réapparaîtra tel quel (pas d'échec silencieux dangereux, juste la régression
// `ThirdPartyStoragePartitioning` qui revient — repérable via bot-detector.rebrowser.net).
const PLAYWRIGHT_DEFAULT_DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'BlockOriginHeaderModificationOnRedirect',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion',
];

// Gabarit du segment "système" de l'UA desktop, un par plateforme host détectable (cf.
// `detectHostPlatformCategory`) — pas de `linux`/`macos`/`windows` à choisir manuellement, ce
// segment doit toujours correspondre au VRAI système d'exploitation que le profil prétend être,
// jamais un autre (cf. doc de `detectHostPlatformCategory` sur `platformMismatch`).
const DESKTOP_UA_OS_SEGMENT: Record<'windows' | 'macos' | 'linux', string> = {
  windows: 'Windows NT 10.0; Win64; x64',
  macos: 'Macintosh; Intel Mac OS X 10_15_7',
  linux: 'X11; Linux x86_64',
};

// Utilisée pour le fallback 'desktop' dans `pickDeviceConfig`, QUE le lancement soit headless ou
// non — découvert en testant un profil headED contre pixelscan.net/fingerprint-check ("Masking
// detected", "Chrome 85 or below") : sans UA explicite, Chromium rapporte son VRAI UA, qui
// révèle littéralement le host (`X11; Linux x86_64`) — en mode headless, il y ajoute même
// littéralement `HeadlessChrome/…`. Ce correctif ciblait à l'origine seulement ce deuxième cas
// (le plus visible), mais le premier existe tout autant en mode headED : `navigator.platform`
// est déjà écrasé par `applyNavigatorOverrides` (qui s'applique sans condition de headless) pour
// correspondre à la plateforme DÉTECTÉE, donc sans UA cohérent, un profil headED se contredirait
// lui-même — exactement le genre d'incohérence qu'un vérificateur de fingerprint sérieux détecte.
// On construit nous-mêmes un UA desktop plausible pour la plateforme réellement détectée (cf.
// `DESKTOP_UA_OS_SEGMENT`), avec la vraie version de Chrome installé pour rester cohérent avec les
// Client Hints. Un seul lancement/fermeture de navigateur par plateforme (toujours en headless,
// peu importe le mode demandé par l'appelant — on a juste besoin de lire la version), mis en cache
// pour tout le process — en pratique une seule entrée sera jamais remplie, le host ne change pas
// en cours de route, mais garder la fonction paramétrable plutôt qu'un singleton évite de devoir
// la retoucher si un jour un même process devait servir plusieurs plateformes.
const cachedDesktopUserAgents = new Map<'windows' | 'macos' | 'linux', Promise<string>>();
async function getDesktopUserAgent(platform: 'windows' | 'macos' | 'linux'): Promise<string> {
  let cached = cachedDesktopUserAgents.get(platform);
  if (!cached) {
    cached = (async () => {
      // `channel: 'chrome'` : même raison que sur le lancement principal dans `build()` (cf. sa
      // doc) — on lit la version du VRAI Chrome installé sur la machine, pas celle du Chromium
      // embarqué par Playwright ("Chrome for Testing"). Sans ce flag ici, cette fonction lirait
      // une version DIFFÉRENTE de celle du navigateur réellement lancé (le `channel` change aussi
      // la version, pas seulement le nom) — un UA spoofé avec une version Chrome qui ne
      // correspond pas au vrai moteur serait une incohérence auto-infligée.
      const browser = await chromium.launch({ headless: true, channel: 'chrome' });
      try {
        const version = await browser.version();
        return `Mozilla/5.0 (${DESKTOP_UA_OS_SEGMENT[platform]}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
      } finally {
        await browser.close();
      }
    })();
    cachedDesktopUserAgents.set(platform, cached);
  }
  return cached;
}

/**
 * Découverte en testant contre pixelscan.net/fingerprint-check (avec un profil passant par un
 * proxy) : résultat "Masking detected" / "Timezone spoofed" — pas un défaut des techniques de
 * masquage JS de ce fichier (confirmé en inspectant le détail du rapport), mais une incohérence
 * géographique toute bête : `timezoneId` vaut par défaut `'Europe/Paris'` (cf. constructeur),
 * sans AUCUN rapport avec le pays de sortie réel du proxy configuré. Pixelscan compare le fuseau
 * annoncé par le JS à l'heure dérivée de la géolocalisation de l'IP et signale l'écart — un vrai
 * utilisateur n'a quasiment jamais un fuseau différent de sa position réseau réelle.
 *
 * Résout le fuseau IANA (ex. `"Africa/Porto-Novo"`) correspondant à l'IP de SORTIE du proxy
 * fourni, via l'API gratuite ip-api.com, elle-même appelée à TRAVERS ce proxy (sinon on
 * géolocaliserait notre propre IP, pas celle que verra le site cible). Best-effort : `null` en
 * cas d'échec (API injoignable, proxy mort, timeout, réponse inattendue) — jamais fatal, cf.
 * l'appelant dans `build()`, qui retombe alors sur `this.timezoneId` (défaut ou valeur fournie).
 *
 * Passe par un vrai navigateur headless jetable (`chromium.launch`) plutôt que
 * `request.newContext()` (le client HTTP léger de Playwright, indépendant d'un vrai processus
 * navigateur) : vérifié empiriquement que ce client léger ne sort tout simplement pas sur le
 * réseau dans cet environnement de dev (timeout systématique, y compris SANS proxy, vers un site
 * pourtant atteignable sans problème via `page.goto()`) — un vrai navigateur est donc plus
 * robuste ici, en plus de reproduire fidèlement la même sémantique réseau/proxy que le contexte
 * final.
 */
async function resolveTimezoneFromProxy(proxy: ProxyConfig): Promise<string | null> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
    });
    const page = await browser.newPage();
    await page.goto('http://ip-api.com/json/?fields=status,timezone', { timeout: 8000 });
    const text = await page.evaluate(() => document.body.innerText);
    const data = JSON.parse(text) as { status?: string; timezone?: string };
    if (data.status === 'success' && typeof data.timezone === 'string' && data.timezone) {
      return data.timezone;
    }
    return null;
  } catch {
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
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
  // Distingue "valeur par défaut" de "fournie explicitement par l'appelant" : sert à ne
  // déclencher la détection auto du fuseau via le proxy (cf. `resolveTimezoneFromProxy`) que
  // lorsque l'appelant n'a PAS déjà choisi un `timezoneId` lui-même, pour ne jamais écraser une
  // intention explicite.
  private timezoneIdExplicit: boolean;

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
    this.timezoneIdExplicit = opts.timezoneId !== undefined;

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
      const userAgent = await getDesktopUserAgent(detectHostPlatformCategory());
      return {
        engine,
        // `viewport: null` plutôt qu'une taille fixe : repéré en utilisant un profil à la main,
        // redimensionner la fenêtre ne changeait RIEN à ce que la page voit — Playwright impose
        // normalement une taille de viewport FIGÉE via une émulation CDP (`Emulation.
        // setDeviceMetricsOverride`), indépendante de la vraie fenêtre, pour la reproductibilité
        // des tests. Un vrai navigateur, lui, voit TOUJOURS sa fenêtre réelle, qui suit le
        // redimensionnement — `viewport: null` désactive cette émulation. La taille choisie plus
        // haut sert plutôt de taille INITIALE de fenêtre, via `--window-size` (cf. `build()`) :
        // la variété entre profils est gardée, mais la fenêtre redevient redimensionnable comme
        // chez un vrai utilisateur. Uniquement pour 'desktop' : un preset mobile (ex. 'Pixel 7')
        // garde son viewport FIXE intentionnellement, un vrai téléphone n'a pas une taille
        // d'écran qu'un utilisateur peut faire varier en tirant sur une fenêtre.
        viewport: null,
        windowSize: viewport,
        isMobile: false,
        hasTouch: false,
        userAgent,
      };
    }
    // `resolveEngineForDevice` a déjà validé que ce device existe et n'est pas un preset
    // Firefox, donc `preset` est forcément défini ici.
    const { defaultBrowserType, ...deviceConfig } = playwrightDevices[this.device];
    if (!deviceConfig.isMobile) {
      // Découvert en testant 'Desktop Safari' contre bot-detector.rebrowser.net ("viewport",
      // 2026-10-26) : même raisonnement que pour 'desktop' ci-dessus (viewport CDP/WebKit figé,
      // indépendant de la vraie fenêtre), appliqué à TOUT preset desktop, pas seulement notre
      // 'desktop' maison — un 'Desktop Safari' a, comme un vrai Mac, une fenêtre réellement
      // redimensionnable. Pas de `windowSize`/`--window-size` ici (mécanisme Chromium-only, cf.
      // `build()`, et sans équivalent CLI sur WebKit) : `viewport: null` suffit à désactiver
      // l'émulation figée, la fenêtre s'ouvre avec la taille par défaut du moteur puis reste
      // redimensionnable — vérifié empiriquement que ça suffit à faire passer le test au vert.
      // `deviceScaleFactor` retiré du spread : Playwright refuse explicitement sa combinaison avec
      // `viewport: null` (`"deviceScaleFactor" option is not supported with null "viewport"`,
      // trouvé en testant) — repli sur le défaut (1) du moteur, comme pour 'desktop' plus haut.
      const { deviceScaleFactor: _deviceScaleFactor, ...deviceConfigWithoutScale } = deviceConfig;
      return { engine, ...deviceConfigWithoutScale, viewport: null };
    }
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
        const { engine, windowSize, ...deviceConfig } = await this.pickDeviceConfig();
        const launcher = engine === 'webkit' ? webkit : chromium;
        proxy = this.proxyRotator ? this.proxyRotator.next(this.proxyStickyKey) : this.proxy;

        // Les flags `--no-sandbox` / `--disable-blink-features=...` sont spécifiques à
        // Chromium (sandboxing et flags Blink) : inutiles sur WebKit, et leur effet sur ce
        // moteur n'est pas garanti, donc on ne les envoie que pour Chromium.
        const engineArgs =
          engine === 'chromium'
            ? {
                // Découvert en testant un profil headED à l'oeil nu (chrome://version/about
                // Chrome) : SANS ce `channel`, Playwright lance son propre Chromium embarqué, qui
                // s'identifie littéralement comme "Google Chrome for Testing" — un build Google
                // distribué spécifiquement pour l'automatisation/CI, PAS pour un usage humain
                // normal, avec des composants retirés (notamment Widevine/DRM — explique une
                // erreur de lecture YouTube constatée). C'est visible à l'oeil (chrome://version)
                // ET potentiellement par des services Google eux-mêmes (reCAPTCHA plus agressif
                // constaté sur la même session) qui ont tout loisir de reconnaître leur propre
                // build de test. `channel: 'chrome'` lance le VRAI Google Chrome installé sur la
                // machine à la place — même moteur Blink, mais le bon nom de produit. Nécessite
                // un vrai Chrome installé sur l'hôte (`npx playwright install chrome` sinon).
                channel: 'chrome',
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
                  // Taille INITIALE de la fenêtre pour le profil 'desktop' (cf. doc de
                  // `pickDeviceConfig`) : remplace le viewport figé par une vraie taille de
                  // fenêtre, redimensionnable comme chez un vrai utilisateur. Absent pour un
                  // preset device (mobile/tablette), qui garde son viewport fixe intentionnel.
                  ...(windowSize ? [`--window-size=${windowSize.width},${windowSize.height}`] : []),
                  // Découvert via bot-detector.rebrowser.net ("storagePartitioning") : Playwright
                  // désactive par défaut le partitionnement de stockage tiers
                  // (`--disable-features=...ThirdPartyStoragePartitioning...`), ce qui permet à
                  // une iframe d'un AUTRE site de lire le localStorage de CETTE page — un vrai
                  // navigateur l'empêche. Un `--enable-features=ThirdPartyStoragePartitioning`
                  // séparé ne suffit PAS à contrer ça : vérifié empiriquement en inspectant la
                  // ligne de commande réelle du process Chromium lancé, Playwright pose SON PROPRE
                  // `--enable-features=CDPScreenshotNewSurface` distinct du nôtre (deux
                  // occurrences du même switch, pas une fusion), et le résultat du test restait
                  // négatif malgré notre ajout. On retire donc le `--disable-features=...` complet
                  // de Playwright via `ignoreDefaultArgs` (la chaîne EXACTE qu'il pose,
                  // lue directement depuis la ligne de commande du process lancé) et on repose
                  // la MÊME liste nous-mêmes, juste sans `ThirdPartyStoragePartitioning`.
                  `--disable-features=${PLAYWRIGHT_DEFAULT_DISABLED_FEATURES.filter((f) => f !== 'ThirdPartyStoragePartitioning').join(',')}`,
                ],
                // Toujours via bot-detector.rebrowser.net ("popupBlocking", "ipcFloodingProtection",
                // "storagePartitioning") : des flags par défaut de PLAYWRIGHT lui-même (pas les
                // nôtres) rendent un comportement détectable — Chrome bloque normalement les
                // popups non déclenchés par un clic, limite les appels IPC rapides (ex.
                // `history.replaceState` en boucle), et partitionne le stockage par site tiers ;
                // Playwright désactive les trois par défaut pour simplifier l'automatisation. On
                // les retire explicitement de la liste de défauts plutôt que de les laisser
                // s'appliquer (le `--disable-features=...` par défaut est retiré ici ET reposé
                // juste au-dessus, sans `ThirdPartyStoragePartitioning`).
                // `--disable-sync` retiré aussi (repéré en utilisant un profil à l'oeil : le menu
                // sélecteur de profil affichait "Votre Chromium" au lieu de "Votre Chrome") : un
                // vrai Chrome jamais connecté a la synchro ACTIVÉE par défaut (juste inactive,
                // faute de compte) — `--disable-sync` est donc lui-même l'écart par rapport à un
                // vrai navigateur, pas l'inverse. Vérifié empiriquement sans ce flag : aucune
                // invite de connexion ni popup intempestif (`chrome://sync-internals` confirme un
                // état "Disabled / Not signed in" parfaitement normal), donc rien à perdre à le
                // retirer — contrairement à une première intuition, à tort trop prudente, qui n'a
                // pas résisté à la vérification.
                ignoreDefaultArgs: [
                  '--disable-popup-blocking',
                  '--disable-ipc-flooding-protection',
                  '--disable-sync',
                  `--disable-features=${PLAYWRIGHT_DEFAULT_DISABLED_FEATURES.join(',')}`,
                ],
              }
            : {};

        // Fuseau horaire aligné sur la sortie réelle du proxy (cf. doc de
        // `resolveTimezoneFromProxy`) : seulement si un proxy est utilisé ET que l'appelant n'a
        // pas déjà choisi `timezoneId` lui-même — jamais question d'écraser un choix explicite.
        let timezoneId = this.timezoneId;
        if (proxy && !this.timezoneIdExplicit) {
          const detected = await resolveTimezoneFromProxy(proxy);
          if (detected) timezoneId = detected;
        }

        // launchPersistentContext = profil isolé sur disque, comme --user-data-dir
        // Cast `BrowserContext` : cf. commentaire sur l'import de `Browser`/`BrowserContext`/`Page`
        // plus haut — `launcher` peut être soit `chromium` (patchright-core) soit `webkit`
        // (playwright-core), deux types nominalement distincts pour TypeScript bien
        // qu'identiques à l'exécution (même protocole CDP/pipe, même shape runtime).
        context = (await launcher.launchPersistentContext(profileDir, {
          headless: this.headless,
          locale: this.locale,
          timezoneId,
          ...(proxy ? { proxy } : {}),
          ...deviceConfig,
          ...engineArgs,
        })) as unknown as BrowserContext;

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

        // `navigator.webdriver` sur WebKit (cf. doc de `hideWebdriverForWebkit`) : Chromium n'en a
        // pas besoin (`--disable-blink-features=AutomationControlled` protège déjà TOUT document),
        // WebKit n'a pas d'équivalent — sans ce correctif, seule la page `about:blank` jetable de
        // `healthCheck` était protégée, pas les vraies pages visitées ensuite (trouvé en testant un
        // profil 'iPhone 15' réel contre bot-detector.rebrowser.net : `navigator.webdriver = true`
        // dès la première navigation).
        if (engine === 'webkit') {
          await context.addInitScript(hideWebdriverForWebkit);
        }

        // Blocage de popups sans geste réel (cf. doc de `patchPopupBlockingForWebkit`) : Chromium
        // n'en a pas besoin (le flag `--disable-popup-blocking` de Playwright est déjà retiré plus
        // haut, le VRAI bloqueur natif de Chrome fait le travail) ; WebKit n'a pas d'équivalent
        // accessible depuis Node (réglage compilé en dur dans le binaire `MiniBrowser` de
        // Playwright), donc réimplémenté nous-mêmes au niveau JS.
        if (engine === 'webkit') {
          await context.addInitScript(patchPopupBlockingForWebkit);
        }

        // `navigator.maxTouchPoints` (cf. doc de `patchMaxTouchPoints`) : uniquement pour les
        // devices à écran tactile (presets mobiles), jamais 'desktop' dont le vrai 0 est correct.
        // 5 : valeur rapportée par un vrai téléphone (Android comme iOS), sur les deux moteurs.
        if ((deviceConfig as { hasTouch?: boolean }).hasTouch) {
          await context.addInitScript(patchMaxTouchPoints, 5);
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

        // cf. doc de `patchHardwareConcurrencyAndWebglVendor` : réimplémente nous-mêmes (sans
        // Proxy) les évasions `navigator.hardwareConcurrency`/`webgl.vendor`, exclues du plugin
        // stealth tiers plus haut (`CHROMIUM_STEALTH_EVASIONS`/`GENERIC_STEALTH_EVASIONS`) pour
        // cette raison. Enregistrée en PREMIER parmi les scripts post-`newPage()` : c'est
        // maintenant ELLE qui fixe `navigator.hardwareConcurrency` (vu que l'évasion du plugin
        // stealth ne s'en charge plus), donc `patchWorkerFingerprint` juste en dessous — qui LIT
        // cette valeur pour la recopier dans chaque worker — doit s'exécuter APRÈS elle. Vérifié
        // empiriquement : dans l'autre ordre, un worker lisait encore 16 coeurs (la vraie valeur
        // hôte) au lieu de 4.
        await context.addInitScript(patchHardwareConcurrencyAndWebglVendor, SPOOFED_HARDWARE_CONCURRENCY);

        // Fingerprint des Web Workers (cf. doc de `patchWorkerFingerprint`) : enregistré
        // seulement MAINTENANT, après `context.newPage()` ET après `patchHardwareConcurrencyAndWebglVendor`
        // ci-dessus (cf. son commentaire). Il lit `navigator.hardwareConcurrency` pour le
        // recopier dans chaque worker.
        await context.addInitScript(patchWorkerFingerprint);

        // cf. doc de `patchWindowOuterDimensions` : remplace l'évasion `window.outerdimensions`
        // du plugin stealth retiré. S'applique aux deux moteurs, sans dépendance de timing
        // particulière (simple affectation, pas un correctif qui doit suivre un autre patch).
        await context.addInitScript(patchWindowOuterDimensions);

        // En-tête HTTP Sec-CH-UA (cf. doc de `applyClientHintsCdpOverride`) : envoyé par Chromium
        // lui-même, "HeadlessChrome" en clair, trouvé en inspectant les en-têtes bruts via
        // tls.peet.ws — indépendant de tout ce qu'on patche en JS. Survit aux redirections HTTP
        // (contrairement à `setExtraHTTPHeaders`, cf. doc) et n'affecte pas la pile réseau/TLS.
        // Ré-appliqué sur toute page future du même contexte (popup/nouvel onglet) : une session
        // CDP n'est pas héritée automatiquement comme le sont les `context.addInitScript`.
        const clientHintsProfile = engine === 'chromium' ? CLIENT_HINTS_BY_PLATFORM[platformCategory] : null;
        if (clientHintsProfile) {
          const ctxForClientHints = context;
          await applyClientHintsCdpOverride(ctxForClientHints, page, clientHintsProfile);
          ctxForClientHints.on('page', (newPage) => {
            applyClientHintsCdpOverride(ctxForClientHints, newPage, clientHintsProfile).catch(() => {});
          });
        }

        // Fingerprint des Service Workers (cf. doc de `patchServiceWorkerFingerprint`) :
        // mécanisme distinct des Workers dédiés ci-dessus, inatteignable par une interception du
        // constructeur `Worker` — patché au niveau réseau via `context.route()`.
        await patchServiceWorkerFingerprint(context, page, clientHintsProfile, engine);

        // Jitter humain avant la première action
        await this.sleep(400 + Math.random() * 800);

        await this.healthCheck(page, engine);

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

  private async healthCheck(page: Page, engine: Engine): Promise<void> {
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
    // `mainWorldEvaluate` (cf. sa doc) plutôt qu'un `page.evaluate` nu : si jamais la branche de
    // repli ci-dessous devait réellement s'exécuter, une redéfinition posée dans le monde ISOLÉ
    // (défaut de Patchright côté Chromium) protégerait un `Navigator.prototype` que RIEN d'autre
    // ne regarde jamais — un vrai script de détection, lui, tourne dans le monde PRINCIPAL. Un
    // faux sentiment de sécurité serait pire que pas de correctif du tout.
    let isWebdriver: unknown;
    try {
      isWebdriver = await mainWorldEvaluate(
        page,
        () => {
          if (navigator.webdriver === true) {
            Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', {
              get: () => false,
              configurable: true,
              enumerable: true,
            });
          }
          return navigator.webdriver;
        },
        engine
      );
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