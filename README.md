# smonster — DriverBuilder furtif pour concours de fingerprinting

Ce README est écrit pour qu'une session Claude Code qui démarre ici **sans aucun contexte préalable**
(notamment sur Windows) puisse reprendre le travail sans rien redécouvrir à l'aveugle. Lis-le en
entier avant de toucher au code.

**Workflow multi-OS (depuis le 2026-10-26)** : ce projet existe en deux copies synchronisées —
`/home/thinolord/Projets/smonster` (Linux, où le code est écrit/modifié) et
`/run/media/thinolord/3692CE7D92CE415B/MySoft/Project/smonster` (disque NTFS partagé, où tourne
`npm install`/les tests **sous Windows**). Après toute modification faite côté Linux, lancer
`scripts/sync-to-ntfs.sh` pour pousser (écraser) les fichiers sources vers la copie NTFS — exclut
toujours `node_modules/`, `dist/` (binaires spécifiques à l'OS, réinstallés/rebuild localement sur
chaque machine) et `.git/` (chaque copie garde son propre historique/config git, notamment
`core.fileMode false` côté NTFS, cf. §7 — un sync de `.git/` l'écraserait silencieusement). Ne
jamais lancer `npm install` depuis Linux sur le dossier NTFS : les binaires installés
(Playwright/Patchright notamment) seraient pour Linux, pas Windows.

## 1. C'est quoi, ce projet

**smonster** est un lanceur de navigateurs Playwright/Patchright "furtifs" (`DriverBuilder`) + un petit
dashboard web (Express) pour gérer des **profils de navigateur multiples**, dans le cadre d'un
**concours de fingerprinting légitime** organisé par un tiers :

- Plusieurs profils de navigateur "undetected", chacun avec sa propre identité/fingerprint.
- Les juges du concours assignent un site de test **inconnu à l'avance**, conçu par les organisateurs
  eux-mêmes, qui prétendent avoir une détection comparable à celle des plus grosses plateformes.
- **Aucune automatisation scriptée d'actions.** Des humains pilotent chaque profil manuellement,
  un par un. Le but de ce code est de randomiser/humaniser le fingerprint du navigateur, **pas**
  de scripter des actions ni de créer des comptes en masse.
- Argent à la clé pour les organisateurs/participants ("millions" mentionnés par l'utilisateur) — donc
  un vrai enjeu de qualité, mais toujours dans un cadre de test autorisé par les organisateurs.

### Ligne éthique à ne jamais franchir

- OK : continuer le travail de cohérence de fingerprint, tester contre des **sites de benchmark publics**
  (liste en §8).
- **PAS OK** : cibler le système anti-fraude/anti-abus d'une vraie plateforme en production pour y
  obtenir un accès (ex. bypass de login réel) — ligne déjà franchie une fois par erreur plus tôt dans le
  projet (épisode X.com), **à ne jamais reproduire**.
- **PAS OK** : s'appuyer sur de la doc/du code tiers pensé pour la création de comptes en masse
  ("AI automation for mass-profile-creation/cookie-farming") — contredit le cadre "pilotage manuel
  uniquement" du concours.

Si une demande future s'éloigne de ce cadre, le signaler avant d'agir plutôt que de supposer que ça
reste couvert par l'autorisation déjà donnée.

## 2. Architecture (vue d'ensemble)

```
app/
  driverBuilder.ts     — le coeur : lance un navigateur furtif (Chromium via Patchright, WebKit via
                          Playwright classique), applique tous les correctifs anti-fingerprint.
                          Lire ce fichier EN ENTIER avant d'y toucher : chaque correctif a un
                          commentaire qui explique POURQUOI il existe (bug trouvé, outil utilisé pour
                          le détecter, ce qui a été essayé avant et rejeté). Ne pas supprimer un
                          commentaire d'investigation sans comprendre ce qu'il protège.
  driverPool.ts         — pool de profils concurrents (factory par slot, max concurrent, limite
                          d'utilisations par profil avant recyclage).
  profileStore.ts       — persistance JSON des profils nommés (data/profiles.json).
  profileManager.ts     — cycle de vie d'un profil nommé (launch/stop/delete/clear-cache/set-proxy,
                          actions bulk) au-dessus de ProfileStore + DriverBuilder.
  proxyRotator.ts       — rotation de proxies (round-robin/random, cooldown après échecs
                          consécutifs, "sticky" par clé).
  server/               — dashboard Express (index.ts = entrypoint, port 3002 par défaut — réservé
                          pour ce projet, cf. VPS_INFRA.md ; httpServer.ts = app Express ;
                          profilesRouter.ts = API REST du dashboard).
  smoketest.ts          — petit script manuel de fumée (lance un profil iPhone 15, va sur
                          example.com).
public/                 — frontend statique du dashboard (vanilla JS, pas de framework).
scripts/setup-fonts.sh  — LINUX UNIQUEMENT : alias fontconfig pour que les profils webkit/macOS
                          "voient" Helvetica Neue/Menlo/Monaco comme installées. Sans objet sur
                          Windows (pas de fontconfig) — si des profils webkit/macOS sont relancés
                          ici, revérifier le fingerprint de polices avec un équivalent Windows
                          (ex. substitution de police via registre, ou accepter l'écart).
data/                   — gitignored, état runtime réel (profiles.json + dossiers de profils
                          Chromium/WebKit persistants). Synchronisé avec le reste du projet, à
                          préserver.
VPS_INFRA.md            — doc d'infra pour un VPS PARTAGÉ avec d'autres projets (TLPosta,
                          cherryfruitz), pas spécifique à smonster. Référence si/quand ce projet
                          est déployé là-bas ; ne pas dupliquer son contenu ici.
```

## 3. Ce qui vient de changer : migration vers Patchright (2026-10-26)

**Contexte** : `puppeteer-extra-plugin-stealth` (utilisé via `playwright-extra`) a été entièrement
retiré du projet. Deux raisons, trouvées en testant contre **bot-detector.rebrowser.net** avec le
code de prod réel :

1. **`runtimeEnableLeak` (rouge)** : Playwright classique active `Runtime.enable` via CDP pour écouter
   la console — effet de bord mesurable (sérialisation anticipée des arguments de log par V8),
   détectable indépendamment de l'ouverture visible des DevTools. **Patchright** (fork de Playwright,
   `Kaliiiiiiiiii-Vinyzu/patchright` sur GitHub) corrige précisément ça en isolant l'exécution JS par
   défaut.
2. **`nativeTampering` (rouge)** : l'outil de détection reconnaît **nommément** une évasion du plugin
   stealth tiers encore active (`iframe.contentWindow`) — ce n'est plus un correctif discret, c'est
   devenu une signature identifiable. Plusieurs autres évasions du plugin (`navigator.permissions`,
   `media.codecs`) utilisent aussi `new Proxy(...)` en interne, détectable structurellement (même
   classe de problème que celle déjà réglée pour `hardwareConcurrency`/`webgl.vendor`, cf.
   `patchHardwareConcurrencyAndWebglVendor` dans driverBuilder.ts).

**Ce qui a été fait** :
- `patchright` ajouté aux dépendances ; `chromium` dans `driverBuilder.ts` vient maintenant de ce
  paquet (pas `playwright-extra`).
- `webkit` reste sur le paquet `playwright` classique : Patchright ne patche QUE Chromium, et son fork
  de webkit vise une révision de binaire différente de celle déjà installée par `playwright` — tester
  `patchright`'s webkit demanderait un téléchargement à part, pour aucun bénéfice (pas d'évasion
  stealth spécifique à WebKit côté Patchright).
- `playwright-extra` + `puppeteer-extra-plugin-stealth` retirés de `package.json`.
- Les évasions qu'on gardait du plugin stealth sont remplacées par du code maison SANS `Proxy`
  (`patchWindowOuterDimensions`, nouveau) ou simplement abandonnées car **redondantes avec le vrai
  Chrome** : depuis un correctif antérieur, `driverBuilder.ts` lance Chromium via `channel: 'chrome'`
  (le vrai Google Chrome installé sur la machine, pas le build "Chrome for Testing" embarqué par
  Playwright) — `window.chrome.app/runtime/csi/loadTimes`, `navigator.plugins`, le support des
  codecs propriétaires... sont déjà natifs, pas besoin de les fabriquer.
- **Piège rencontré et résolu** : Patchright fait tourner `page.evaluate()` dans un **monde JS isolé**
  par défaut côté Chromium (même mécanisme que les content scripts d'extension — chaque monde a sa
  propre copie des prototypes DOM/WebIDL). Un correctif posé via `context.addInitScript()` (monde
  PRINCIPAL) devient donc invisible à un `page.evaluate()` naïf. Nouvel helper exporté
  `mainWorldEvaluate(page, fn, engine)` dans `driverBuilder.ts` : passe `isolatedContext: false` en
  4e argument positionnel de `evaluate()` côté Chromium, **mais PAS côté webkit** — `playwright`
  classique n'a pas ce paramètre et lève `"Too many arguments..."` si on le lui passe quand même.
  D'où le paramètre `engine` obligatoire sur ce helper : ne jamais l'oublier en ajoutant un nouveau
  `page.evaluate()` qui doit lire un état patché par `addInitScript`.
- **76/76 tests passent** après migration (9 ont cassé au premier passage à cause du piège ci-dessus,
  tous corrigés en adoptant `mainWorldEvaluate`).
- Revérifié empiriquement contre bot-detector.rebrowser.net avec le code de prod migré :
  `runtimeEnableLeak` et `nativeTampering` passent au vert, aucune régression sur les points déjà
  verts (`storagePartitioning`, `popupBlocking`, `ipcFloodingProtection`, `viewport`,
  `workerConsistency`...).

**Rien n'a été commité.** `git status` montre encore `driverBuilder.ts`, `driverBuilder.test.ts`,
`package.json`, `package-lock.json` modifiés en working tree — décision de commit à prendre par
l'utilisateur, pas automatique (règle permanente, cf. §9).

## 4. `platformMismatch` — RÉSOLU (2026-10-26) : détection automatique du vrai système hôte

**Le problème** : contre bot-detector.rebrowser.net, un profil qui prétend "Windows" (UA +
`navigator.platform` + Client Hints) révèle quand même l'OS réel via `CSS ActiveText` — ce mot-clé
couleur système (CSS Color Module niveau 4) est résolu par le moteur natif de Chromium
(`NativeTheme`, en C++), qui interroge le VRAI thème de l'OS hôte. Code source de leur test inspecté
directement (`index.js` du détecteur) :

```js
function getSystemColor(name, colorScheme) {
  const el = document.createElement('div')
  el.style.setProperty('color-scheme', colorScheme, 'important')
  el.style.setProperty('color', name, 'important')  // name = 'ActiveText'
  document.body.appendChild(el)
  return getComputedStyle(el).color
}
// Se déclenche si : claimsWindows && activeTextLight === 'rgb(255, 0, 0)'
```

Sur Linux **et** macOS, Chrome retombe sur une palette intégrée fixe (rouge pur) pour `ActiveText` —
seul un Chrome qui tourne **vraiment** sous Windows va chercher la vraie couleur "hotlight" via l'API
Windows (`GetSysColor`). Aucun flag Chromium, aucun override JS légitime ne touche ce chemin :
`navigator.platform`/l'UA ne changent que des valeurs JS, jamais le rendu natif.

**La solution implémentée** : le device `'desktop'` (Chromium) **détecte maintenant le vrai système
hôte** via `process.platform` (`detectHostPlatformCategory()` dans `driverBuilder.ts`, exportée) et
claim CE système au lieu de "Windows" en dur — donc toujours honnête, peu importe la machine :
- Lancé sous Windows → claim Windows.
- Lancé sous Linux → claim Linux (nouvelle catégorie `PlatformCategory: 'linux'` — UA, `navigator.
  platform` ('Linux x86_64'), Client Hints (`platform: 'Linux'`, `platformVersion: ''` — Chromium
  n'a pas de notion de version d'OS sur Linux), liste de polices (DejaVu/Liberation/Noto/Cantarell,
  vérifiées réellement installées via `fc-list` plutôt que supposées).
- Lancé sous macOS → claim macOS (réutilise la catégorie `'macos'` déjà existante, jusque-là
  seulement utilisée côté WebKit).

**Vérifié empiriquement de bout en bout** (2026-10-26, via le vrai `build()`, pas un script
jetable) : `platformMismatch` passe au vert sur cette machine Linux, zéro régression sur le reste du
rapport bot-detector.rebrowser.net.

**Indicateur ajouté dans le dashboard** : avant, rien n'indiquait quel OS un profil "desktop" allait
prétendre être — invisible dans l'UI. Un petit texte apparaît maintenant sous le sélecteur de device
(création ET édition de profil) quand "desktop" est choisi : "→ ce profil va claim : Linux (système
hôte détecté)". Alimenté par un nouvel endpoint `GET /api/host-info` (`{ desktopPlatform: 'linux' |
'windows' | 'macos' }`). Les autres presets (iPhone 15, Pixel 7, Desktop Safari...) n'ont pas cet
indicateur : ce sont des émulations figées, déjà explicites dans leur nom, rien à détecter pour eux.

**Reste à tester une fois sur Windows** (la synchro Linux/NTFS mise en place sert justement à ça) :
confirmer que `platformMismatch` reste vert là-bas aussi (ça devrait, la détection est automatique),
et vérifier qu'aucune AUTRE fuite native spécifique à Windows n'apparaît (rendu de curseur,
anticrénelage des polices...) — zone qu'on n'a pas encore explorée.

Un patch JS ciblé sur `getComputedStyle` avait été envisagé puis explicitement écarté : n'aurait
couvert qu'une seule technique (~17 mots-clés couleur système existent au total), et c'est le genre
de rustine fragile et repérable qu'on vient de retirer en abandonnant le plugin stealth (§3). La
détection du vrai host règle le problème à la racine plutôt que de patcher autour.

## 5. Audit des presets non-desktop (2026-10-26) — tous testés contre bot-detector.rebrowser.net

Suite à une question directe ("les presets non-desktop sont bons ? passe bien undetect et
propre ?"), chaque preset du dashboard a été lancé pour de vrai (pas un test unitaire — le vrai
`build()`) contre bot-detector.rebrowser.net. Deux bugs réels trouvés et corrigés, un preset retiré :

1. **`navigator.webdriver = true` sur TOUT profil WebKit dès la première navigation** (🔴, le pire
   trouvé cette session) — `healthCheck()` neutralise bien `navigator.webdriver`, mais seulement sur
   `about:blank`, la page jetable où il tourne ; ce correctif ne survit pas à la navigation suivante
   (WebKit n'a pas d'équivalent du flag Chromium `--disable-blink-features=AutomationControlled`,
   qui protège TOUT document, pas qu'un seul). Concrètement : un profil 'iPhone 15'/'iPad
   Mini'/'Desktop Safari' se déclarait automate sur CHAQUE vraie page visitée. Corrigé par
   `hideWebdriverForWebkit`, enregistrée via `context.addInitScript` (s'applique à CHAQUE nouveau
   document) plutôt qu'une correction ponctuelle sur `about:blank` — avec le masquage `toString()`
   habituel (WeakMap, jamais de Proxy) pour ne pas se faire repérer par `nativeTampering` à son tour.
2. **`navigator.maxTouchPoints` incohérent avec un vrai téléphone, sur les deux moteurs** (🟡) :
   Chromium rapportait 1 (défaut de l'émulation tactile CDP de Playwright, un vrai Android rapporte
   5), WebKit rapportait carrément 0 (UA mobile sans AUCUN support tactile signalé, repéré comme
   incohérent par l'outil). Corrigé par `patchMaxTouchPoints(5)`, appliqué à tout device
   `hasTouch: true` (jamais à 'desktop').
3. **`'Desktop Safari'` gardait un viewport Playwright figé** (🟡) : le correctif `viewport: null`
   (fenêtre réellement redimensionnable) n'était appliqué qu'à notre 'desktop' maison, pas aux
   autres presets desktop. Généralisé dans `pickDeviceConfig()` à tout preset `!isMobile` (avec un
   piège au passage : `deviceScaleFactor` doit être retiré du spread, Playwright refuse sa
   combinaison avec `viewport: null`).
4. **`'Desktop Chrome'` (preset générique Playwright) retiré du dashboard** — déjà strictement moins
   bon que 'desktop' (UA figée à une version de Chrome différente du vrai Chrome installé), et rendu
   carrément CASSÉ par la détection auto du host (§4) : son UA figée reste "Windows" alors que
   `navigator.platform`/Client Hints suivent désormais le vrai host (Linux ici) — `platformMismatch`
   rouge garanti. 'desktop' fait tout pareil, en mieux.

**Résultat final, tous testés à nouveau après correctifs** :
- 'Pixel 7' (Android/Chromium) : **0 finding**, entièrement propre.
- 'iPhone 15' (iOS/WebKit), 'iPad Mini' (iOS/WebKit), 'Desktop Safari' (macOS/WebKit) : plus qu'un
  seul 🟡 chacun (`popupBlocking`) — pas de correctif WebKit-side connu (contrairement à Chromium,
  qui a le flag `--disable-popup-blocking` CLI), et l'outil lui-même dit que ça peut être un
  réglage de site légitime, pas forcément un signal d'automatisation. Laissé tel quel.

## 6. Bug critique corrigé : Service Worker cassait des sites réels (YouTube) — page blanche

**Symptôme signalé par l'utilisateur** : sur un vrai profil desktop, YouTube jouait le son/vidéo
normalement mais n'affichait STRICTEMENT RIEN (page blanche) — aucun accès réseau possible depuis
ce sandbox pour reproduire en direct, bug diagnostiqué et confirmé par LECTURE du code seule.

**Cause** : `patchServiceWorkerFingerprint` (patch réseau qui fait croire à un Service Worker qu'il
tourne sur la plateforme spoofée, cf. §2) utilisait `context.route('**/*', ...)` et ciblait TOUTE
requête pour laquelle `request.serviceWorker()` est non-null, en assumant que c'était toujours du
JS — et lui préfixait du code JS devant la réponse. Faux pour un vrai Service Worker de production :
un mécanisme de précaching (type Workbox, ce que fait YouTube) fait aussi des `fetch()` internes
pour mettre en cache du CSS/JSON/images/polices — toutes ces requêtes ont AUSSI
`request.serviceWorker()` non-null. Le correctif préfixait donc du JS devant n'importe laquelle de
ces ressources, les corrompant silencieusement (un CSS ou JSON avec du JS collé devant n'est plus
valide) — cassant le chargement normal du site sans toucher à la lecture vidéo native (indépendante
de ce JS cassé), d'où le symptôme exact observé.

**Corrigé** : vérification du `Content-Type` réel de la réponse avant de réécrire — seule une
réponse qui s'annonce vraiment comme `javascript`/`ecmascript` est patchée, tout le reste (CSS,
JSON, images...) ressort strictement inchangé. Nouveau test de régression ajouté (simule un Service
Worker qui `fetch()` un JSON pendant son installation, vérifie qu'il ressort identique).

## 7. Mise en route sur une machine neuve

```bash
npm install                  # installe tout, y compris `patchright` (ex playwright-extra + stealth)
npx playwright install chrome  # si le vrai Google Chrome n'est pas déjà installé sur la machine —
                                # `channel: 'chrome'` dans driverBuilder.ts en dépend directement
npx playwright install webkit  # pour les presets iOS/macOS (Desktop Safari, iPhone 15...)
npm run typecheck
npm run build
npm test                     # 76 tests, doit passer à 76/76
```

**IMPORTANT — toujours installer depuis l'OS qui va exécuter le code.** Sur la copie NTFS partagée,
`npm install` doit tourner **sous Windows**, jamais depuis une session Linux qui a juste monté le
disque (les binaires Playwright/Patchright installés seraient pour le mauvais OS).

**`core.fileMode`** : la copie NTFS vit sur un disque monté en FUSE sous Linux. Le mount FUSE fait
apparaître tous les fichiers comme exécutables, ce qui fait croire à `git` que tout est modifié alors
que le contenu est identique. `git config core.fileMode false` déjà appliqué dans ce clone — si tu
clones ailleurs sur NTFS/FAT, refaire cette commande avant de regarder `git status`.

## 8. Sites de test / benchmark autorisés

- bot.sannysoft.com
- CreepJS (abrahamjuliot.github.io/creepjs)
- Pixelscan (pixelscan.net/fingerprint-check)
- tls.peet.ws (empreinte TLS/JA3, en-têtes bruts)
- bot-detector.rebrowser.net — celui utilisé pour tout le diagnostic de la migration Patchright
  (§3-4) ; son script est en `index.js`, directement lisible côté client, très utile pour comprendre
  EXACTEMENT ce qu'un check teste avant de décider comment le corriger.
- bot.incolumitas.com
- browserscan.net/bot-detection

**Jamais** de test contre une vraie plateforme cible en production (cf. §1).

## 9. Règles de travail permanentes (déjà établies, à respecter sans qu'on les redemande)

- **Ne jamais commiter sans que l'utilisateur le demande explicitement.** Les changements de cette
  session (migration Patchright) sont volontairement laissés en working tree, pas commités.
- Pas d'automatisation d'actions humaines (clics, formulaires, navigation scriptée en boucle) — ce
  projet construit des navigateurs, il ne les pilote pas pour le compte de l'utilisateur dans un
  contexte de concours.
- Avant de changer un comportement de `driverBuilder.ts`, **toujours vérifier empiriquement** (test
  contre un des sites du §8, ou test unitaire) plutôt que de supposer qu'un correctif marche — c'est
  le pattern suivi tout du long sur ce projet, visible dans les commentaires du code lui-même.
- Un commentaire qui explique une découverte empirique (bug trouvé, outil utilisé, piste rejetée) ne
  doit pas être supprimé ou résumé en l'enlevant — c'est la mémoire du projet, plus fiable qu'un
  README qui peut devenir obsolète.
- **Synchro Linux → NTFS** : après toute modif faite côté Linux, lancer
  `bash scripts/sync-to-ntfs.sh` (rsync avec `--delete`, exclut `node_modules/`, `dist/`, `.git/`).
  Sens unique : Linux → NTFS seulement. Ne jamais lancer `npm install` sur le dossier NTFS depuis
  Linux.
- Remote git : `https://github.com/dyothniel/smonster.git` (nom `smonster`). Ne pas push sans
  demande explicite.
