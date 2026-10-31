import * as fs from 'fs';
import * as path from 'path';
import type { Socket } from 'socket.io-client';
import { DriverBuilder, resolveEngineForDevice, resolveGeoFromProxy } from '../../app/driverBuilder';
import type { BuiltDriver, DriverBuilderOptions, ProxyConfig } from '../../app/driverBuilder';
import type { CloudClient } from './cloudClient';
import { packProfileState, unpackProfileState, clearProfileCache, getProfileCacheSize, getProfileStateSize } from './profileStateSync';

export interface LaunchHealth {
  ok: boolean;
  at: string;
  error?: string;
}

export interface ProxyHealth {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  ip?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  zip?: string | null;
  lat?: number | null;
  lon?: number | null;
  timezone?: string | null;
}

export interface CloudProfileRecord {
  id: string;
  teamId: string;
  name: string;
  device: string;
  locale: string;
  timezoneId: string;
  headlessDefault: boolean;
  proxy: ProxyConfig | null; // déjà résolu (proxyId -> proxy déchiffré) par l'appelant IPC, cf. ipc.ts
  // Déjà résolu depuis `ExtensionsStore` (local à cette machine) par l'appelant IPC, même esprit
  // que `proxy` ci-dessus. Absent/vide : aucune extension chargée.
  extensionPaths?: string[];
}

interface AcquireAck {
  ok: boolean;
  error?: string;
}

function emitWithAck<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

/**
 * Adapté de `app/profileManager.ts` (cf. plan) : même esprit (orchestration au-dessus de
 * `DriverBuilder` pour des profils nommés, adressables individuellement), mais la config vient
 * du catalogue CLOUD synchronisé (pas d'un `ProfileStore` JSON local), et `launch()`/`stop()`
 * encadrent maintenant le cycle complet acquire-verrou → télécharger-état → lancer /
 * arrêter → empaqueter-état → uploader → libérer-verrou (cf. doc du plan, section synchro).
 *
 * `DriverBuilder`/`DriverPool` eux-mêmes restent totalement inchangés — importés tels quels
 * depuis `app/`, aucune de leur logique de furtivité n'est dupliquée ou modifiée ici.
 */
export class ElectronProfileManager {
  private readonly running = new Map<string, BuiltDriver>();
  // Le record complet (teamId, device...) de chaque profil actif SUR CETTE MACHINE — nécessaire
  // pour pouvoir le ré-empaqueter/uploader/libérer à la fermeture de l'app sans dépendre du
  // renderer (cf. `stopAll()`, appelée depuis `app.on('before-quit')` dans ipc.ts, où le
  // catalogue du renderer n'est plus interrogeable à temps).
  private readonly activeRecords = new Map<string, CloudProfileRecord>();
  // Diagnostic PUR local, jamais synchronisé (pas de colonne pour ça côté cloud, et ça n'aurait
  // pas de sens de l'être - "le dernier lancement a échoué" ne veut dire quelque chose que pour
  // LA machine qui l'a tenté). Perdu au redémarrage de l'app : acceptable, c'est un indicateur
  // de diagnostic récent, pas un historique à conserver.
  private readonly lastLaunchResults = new Map<string, LaunchHealth>();

  constructor(
    private readonly localProfilesRoot: string,
    private readonly cloud: CloudClient,
    private readonly socket: Socket
  ) {}

  private profileDir(id: string): string {
    return path.join(this.localProfilesRoot, id);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  async launch(record: CloudProfileRecord, machineLabel: string): Promise<BuiltDriver> {
    const existing = this.running.get(record.id);
    if (existing) return existing; // déjà actif sur CETTE machine : no-op idempotent

    const ack = await emitWithAck<AcquireAck>(this.socket, 'profile:acquire', {
      teamId: record.teamId,
      profileId: record.id,
      machineLabel,
    });
    if (!ack.ok) {
      throw new Error(
        ack.error === 'already_in_use'
          ? 'Ce profil est déjà utilisé par un autre membre de la team en ce moment.'
          : "Impossible d'acquérir ce profil (droits insuffisants ?)."
      );
    }

    try {
      const dir = this.profileDir(record.id);
      const archive = await this.cloud.getBinary(`/api/teams/${record.teamId}/profiles/${record.id}/state`);
      if (archive) {
        await unpackProfileState(dir, archive);
      }

      const builder = new DriverBuilder({
        profileDir: dir,
        headless: record.headlessDefault,
        // `record.device` vient du catalogue cloud (colonne TEXT libre côté serveur, cf. schema.sql)
        // — `DriverBuilder.build()` valide lui-même la valeur (`resolveEngineForDevice` lève une
        // erreur claire "Device inconnu" sinon), pas besoin de revalider ici.
        device: record.device as NonNullable<DriverBuilderOptions['device']>,
        // "auto" (sentinel choisi côté UI, cf. app.js) -> omis plutôt que transmis tel quel, pour
        // que `DriverBuilder` le voie comme NON fourni et déclenche sa propre résolution
        // automatique depuis le proxy (cf. `resolveGeoFromProxy`/`localeExplicit`/
        // `timezoneIdExplicit` dans driverBuilder.ts) plutôt que de tenter de lancer avec un
        // fuseau IANA ou une locale littéralement nommée "auto".
        ...(record.locale && record.locale !== 'auto' ? { locale: record.locale } : {}),
        ...(record.timezoneId && record.timezoneId !== 'auto' ? { timezoneId: record.timezoneId } : {}),
        ...(record.proxy ? { proxy: record.proxy } : {}),
        ...(record.extensionPaths && record.extensionPaths.length > 0 ? { extensionPaths: record.extensionPaths } : {}),
        // Filet de sécurité (cf. driverBuilder.ts) : un profil d'équipe partagé ne doit jamais
        // être supprimé automatiquement, quoi qu'il arrive.
        keepProfile: true,
      });
      const driver = await builder.build();
      this.running.set(record.id, driver);
      this.activeRecords.set(record.id, record);
      this.lastLaunchResults.set(record.id, { ok: true, at: new Date().toISOString() });
      return driver;
    } catch (err) {
      // Le lancement a échoué APRÈS avoir acquis le verrou : le relâcher, sinon ce profil reste
      // bloqué pour toute la team jusqu'au prochain redémarrage du serveur.
      this.socket.emit('profile:release', { teamId: record.teamId, profileId: record.id });
      this.lastLaunchResults.set(record.id, { ok: false, at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  async stop(record: CloudProfileRecord): Promise<void> {
    const driver = this.running.get(record.id);
    if (!driver) return; // pas actif sur CETTE machine : no-op (cohérent avec l'ancien profileManager.ts)
    await DriverBuilder.quit(driver.context);
    this.running.delete(record.id);
    this.activeRecords.delete(record.id);

    // Empaqueter/uploader APRÈS la fermeture du navigateur (fichiers plus verrouillés par le
    // process) et AVANT de relâcher le verrou cloud (cf. doc du plan : garantit que le prochain
    // utilisateur reçoit toujours l'état le plus frais).
    const engine = resolveEngineForDevice(record.device as NonNullable<DriverBuilderOptions['device']>);
    const archive = await packProfileState(this.profileDir(record.id), engine);
    await this.cloud.putBinary(`/api/teams/${record.teamId}/profiles/${record.id}/state`, archive);

    await emitWithAck(this.socket, 'profile:release', { teamId: record.teamId, profileId: record.id });
  }

  /**
   * Vide le cache HTTP/GPU/Service-Worker local (jamais les cookies/sessions, cf.
   * profileStateSync.ts) — repris de l'ancien `app/profileManager.ts`, mais scopé au cache pur
   * plutôt qu'à tout le dossier : dans ce projet, un profil est désormais un état d'équipe partagé
   * (synchro cookies/sessions, cf. plan), le vider en entier comme l'ancienne version l'aurait
   * silencieusement effacé pour tous les membres au prochain upload d'état. Arrête le profil
   * d'abord s'il tourne SUR CETTE machine (fichiers verrouillés par le navigateur sinon).
   */
  async clearCache(record: CloudProfileRecord): Promise<void> {
    if (this.running.has(record.id)) await this.stop(record);
    const engine = resolveEngineForDevice(record.device as NonNullable<DriverBuilderOptions['device']>);
    clearProfileCache(this.profileDir(record.id), engine);
  }

  /**
   * Vue "santé & données" pour l'écran "Modifier" — reprend ce que l'ancienne page `profile.html`
   * affichait (`Dossier du profil` / `Cache`, cf. public/profile.html d'avant la réécriture
   * Electron), perdu de vue pendant le portage, plus deux infos qui n'existaient pas avant la
   * synchro d'équipe : `stateBytes` (poids réel des données de session, distinct du cache
   * jetable) et `lastLaunch` (dernier essai de lancement SUR CETTE machine). `folderPath` est
   * toujours renvoyé même si le dossier n'existe pas encore ("jamais lancé" est une info valide
   * en soi) ; `cacheBytes`/`stateBytes` valent alors simplement 0.
   */
  async getDiskInfo(record: CloudProfileRecord): Promise<{ folderPath: string; cacheBytes: number; stateBytes: number; lastLaunch: LaunchHealth | null }> {
    const dir = this.profileDir(record.id);
    const engine = resolveEngineForDevice(record.device as NonNullable<DriverBuilderOptions['device']>);
    const exists = fs.existsSync(dir);
    const [cacheBytes, stateBytes] = await Promise.all([
      exists ? getProfileCacheSize(dir, engine) : Promise.resolve(0),
      exists ? getProfileStateSize(dir, engine) : Promise.resolve(0),
    ]);
    return { folderPath: dir, cacheBytes, stateBytes, lastLaunch: this.lastLaunchResults.get(record.id) ?? null };
  }

  /** Vérifie qu'un proxy répond ET remonte sa géolocalisation apparente (IP/pays/ville/
   * coordonnées), comme le "Check proxy" d'AdsPower — réutilise `resolveGeoFromProxy` (même
   * résolution que l'auto-détection fuseau/locale au lancement, cf. driverBuilder.ts) plutôt
   * qu'un simple ping TCP : si la requête ip-api.com aboutit À TRAVERS ce proxy, c'est déjà la
   * preuve qu'il est joignable, avec en prime de quoi l'afficher à l'utilisateur. N'a pas besoin
   * d'un profil, juste de la config proxy elle-même (résolue par l'appelant IPC). */
  async testProxy(proxy: ProxyConfig): Promise<ProxyHealth> {
    const start = Date.now();
    const geo = await resolveGeoFromProxy(proxy);
    if (!geo) {
      return { ok: false, error: 'Proxy injoignable, ou requête bloquée (délai de 8s dépassé)' };
    }
    return {
      ok: true,
      latencyMs: Date.now() - start,
      ip: geo.ip,
      country: geo.country,
      region: geo.region,
      city: geo.city,
      zip: geo.zip,
      lat: geo.lat,
      lon: geo.lon,
      timezone: geo.timezone,
    };
  }

  /**
   * Arrête tout ce qui tourne encore SUR CETTE MACHINE — appelé à la fermeture de l'app (cf.
   * `app.on('before-quit')` dans ipc.ts). Ne prend aucun paramètre : `activeRecords` suffit,
   * c'est tout l'intérêt de le garder à jour en interne plutôt que de dépendre du renderer.
   */
  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.activeRecords.values()].map((record) => this.stop(record)));
  }
}
