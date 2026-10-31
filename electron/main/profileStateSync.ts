import * as fs from 'fs';
import * as path from 'path';
import * as tar from 'tar';

// Pas d'import de `Engine` depuis `app/driverBuilder.ts` : ce type n'y est pas exporté (et ne
// doit pas être modifié pour ça, cf. plan — `driverBuilder.ts` reste intact). Union littérale
// locale, identique.
type Engine = 'chromium' | 'webkit';

/**
 * Quels fichiers/dossiers d'un profil navigateur portent une vraie SESSION (cookies, connexions)
 * — à synchroniser entre machines — vs du cache pur, sans valeur à synchroniser (cf. plan,
 * section "Synchronisation de l'état du profil"). Chemins confirmés EMPIRIQUEMENT (pas devinés)
 * en inspectant un vrai profil généré par `DriverBuilder` sur cette machine (2026-10-30),
 * `Default/Cookies` notamment contredit une hypothèse de départ qui s'attendait à
 * `Default/Network/Cookies` sur les versions récentes de Chrome — toujours vérifier plutôt que
 * supposer.
 *
 * Chromium (`Default/` est le sous-dossier du profil "par défaut" que `DriverBuilder` utilise) :
 *   - `Cookies`/`Cookies-journal` : cookies (SQLite + journal de transaction).
 *   - `Local Storage/` : `localStorage` de chaque origine (leveldb).
 *   - `IndexedDB/` : bases IndexedDB de chaque origine (un sous-dossier leveldb par origine).
 *   - `WebStorage` : métadonnées de quota/buckets de stockage (Storage Buckets API).
 *   - `Login Data*`/`Login Data For Account*` : mots de passe enregistrés, si l'utilisateur en a
 *     sauvegardé — directement utile à l'objectif "éviter les reconnexions".
 * Explicitement EXCLU : `Cache`/`Code Cache`/`GPUCache`/`Dawn*Cache` (cache pur, parfois énorme,
 * aucune valeur de session) et `Session Storage` (scope = un seul onglet/une seule session de
 * navigation, pas destiné à survivre à un redémarrage même sur un vrai navigateur).
 *
 * WebKit (profil SANS sous-dossier `Default/`, structure différente de Chromium) :
 *   - `cookies.txt` : cookies (format texte, pas SQLite).
 *   - `storage/` : stockage unifié par origine (localStorage ET IndexedDB colocalisés sous un
 *     chemin haché par origine, propre à l'implémentation WebKit — on prend le dossier entier
 *     plutôt que de recalculer ce hash nous-mêmes, qui dépendrait de détails internes de
 *     WebKit susceptibles de changer).
 * Explicitement EXCLU : `WebKitCache`/`CacheStorage`/`mediakeys` (cache), `isolatedsites`
 * (métadonnées d'isolation de site, sans rapport avec une session utilisateur).
 */
const STATE_PATHS_BY_ENGINE: Record<Engine, string[]> = {
  chromium: [
    'Default/Cookies',
    'Default/Cookies-journal',
    'Default/Local Storage',
    'Default/IndexedDB',
    'Default/WebStorage',
    'Default/Login Data',
    'Default/Login Data-journal',
    'Default/Login Data For Account',
    'Default/Login Data For Account-journal',
  ],
  webkit: ['cookies.txt', 'storage'],
};

/**
 * Chemins (profil-relatifs) du cache HTTP/GPU/Service-Worker pur — strictement disjoints de
 * `STATE_PATHS_BY_ENGINE` ci-dessus, jamais les cookies/sessions. Confirmés EMPIRIQUEMENT sur un
 * vrai profil Chromium généré par `DriverBuilder` (2026-10-31) : `GPUPersistentCache` vit à la
 * RACINE du profil (pas sous `Default/`), et le nom réel est `DawnWebGPUCache` (pas `DawnCache`,
 * contrairement à ce qu'un nom plausible aurait suggéré). Exclut volontairement les téléchargements
 * du component updater de Chrome (`CaptchaProviders`, `OnDeviceHeadSuggestModel`, etc.) : ce ne
 * sont pas des données de site, les vider ne "nettoie" rien côté fingerprinting/espace utile, juste
 * un re-téléchargement forcé au prochain lancement. Pour WebKit, noms déjà documentés comme exclus
 * de la synchro ci-dessus (`WebKitCache`/`CacheStorage`/`mediakeys`), pas re-vérifiés séparément ici
 * faute de profil WebKit sous la main au moment de l'écriture — à confirmer si ça s'avère faux.
 */
const CACHE_PATHS_BY_ENGINE: Record<Engine, string[]> = {
  chromium: [
    'Default/Cache',
    'Default/Code Cache',
    'Default/GPUCache',
    'Default/DawnWebGPUCache',
    'Default/DawnGraphiteCache',
    'Default/Service Worker/CacheStorage',
    'Default/Service Worker/ScriptCache',
    'GPUPersistentCache',
  ],
  webkit: ['WebKitCache', 'CacheStorage', 'mediakeys'],
};

/** Vide uniquement le cache (jamais les cookies/sessions, cf. doc ci-dessus) d'un profil local.
 * Sûr à appeler même si le profil n'a jamais été lancé (chemins absents, filtrés en silence). */
export function clearProfileCache(profileDir: string, engine: Engine): void {
  for (const rel of CACHE_PATHS_BY_ENGINE[engine]) {
    const target = path.join(profileDir, rel);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
}

/** Taille récursive d'un fichier/dossier, en octets. `fs.promises` (pas `*Sync`) : un cache
 * HTTP réel peut contenir des milliers de petites entrées, un parcours synchrone bloquerait tout
 * le process main (donc toute l'app, IPC compris) pendant le calcul. */
async function dirSize(target: string): Promise<number> {
  let stat;
  try {
    stat = await fs.promises.stat(target);
  } catch {
    return 0; // chemin absent (profil jamais lancé, ou déjà vidé) : 0, pas une erreur
  }
  if (!stat.isDirectory()) return stat.size;
  const entries = await fs.promises.readdir(target);
  const sizes = await Promise.all(entries.map((entry) => dirSize(path.join(target, entry))));
  return sizes.reduce((sum, s) => sum + s, 0);
}

/** Taille totale du cache (mêmes chemins que `clearProfileCache`) d'un profil local, en octets. */
export async function getProfileCacheSize(profileDir: string, engine: Engine): Promise<number> {
  const sizes = await Promise.all(CACHE_PATHS_BY_ENGINE[engine].map((rel) => dirSize(path.join(profileDir, rel))));
  return sizes.reduce((sum, s) => sum + s, 0);
}

/** Taille totale de l'état partagé LOCAL (mêmes chemins que `packProfileState`, cf.
 * STATE_PATHS_BY_ENGINE) — approximation de ce qui serait uploadé au prochain `stop()`, pas la
 * taille exacte de l'archive gzip déjà sur le serveur (ça demanderait un aller-retour réseau pour
 * rien, cette taille locale suffit comme indicateur "poids des données de session"). */
export async function getProfileStateSize(profileDir: string, engine: Engine): Promise<number> {
  const sizes = await Promise.all(STATE_PATHS_BY_ENGINE[engine].map((rel) => dirSize(path.join(profileDir, rel))));
  return sizes.reduce((sum, s) => sum + s, 0);
}

/** Construit l'archive `.tar.gz` à partir des fichiers/dossiers pertinents d'UN profil local. */
export async function packProfileState(profileDir: string, engine: Engine): Promise<Buffer> {
  // Liste vide acceptée (profil jamais lancé, ou lancé sans qu'aucun site n'ait rien stocké) :
  // une archive VIDE est un état valide, pas une erreur — `tar.create` n'y voit aucun problème.
  const candidates = STATE_PATHS_BY_ENGINE[engine].filter((rel) => fs.existsSync(path.join(profileDir, rel)));
  // cf. doc de `DataEventStream` : `Pack` est un vrai flux `on('data'/'end'/'error')` standard à
  // l'exécution, juste typé différemment par `tar` (son propre système d'évènements génériques).
  return streamToBuffer(tar.create({ gzip: true, cwd: profileDir }, candidates) as unknown as DataEventStream);
}

/** Extrait une archive téléchargée dans le dossier de profil LOCAL, avant de lancer le navigateur. */
export async function unpackProfileState(profileDir: string, archive: Buffer): Promise<void> {
  fs.mkdirSync(profileDir, { recursive: true });
  const { Readable } = await import('stream');
  await new Promise<void>((resolve, reject) => {
    Readable.from(archive)
      .pipe(tar.extract({ cwd: profileDir }))
      .on('finish', resolve)
      .on('error', reject);
  });
}

// `tar.create(...)` renvoie un `Pack` (flux minipass interne à la lib `tar`), qui n'implémente
// pas structurellement la pleine interface `NodeJS.ReadableStream` attendue par les types —
// désaccord de typage entre deux libs, pas un vrai problème à l'exécution (c'est un vrai flux
// Node standard niveau `on('data'/'end'/'error')`). Type structurel minimal pour ce qu'on utilise
// réellement, plutôt qu'un `any` générique.
interface DataEventStream {
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  on(event: 'end', cb: () => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
}

function streamToBuffer(stream: DataEventStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
