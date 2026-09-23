import * as fs from 'fs';
import * as path from 'path';
import { DriverBuilder } from './driverBuilder';
import type { BuiltDriver, ProxyConfig } from './driverBuilder';
import { ProfileStore } from './profileStore';
import type { CreateProfileInput, ProfileRecord, UpdateProfileInput } from './profileStore';

export interface ProfileStatus extends ProfileRecord {
  /** Un driver est enregistré pour ce profil dans ce process (peut être vrai même si le
   * navigateur sous-jacent vient de crasher — voir `connected`). */
  running: boolean;
  /** `running && browser.isConnected()` — reflète l'état réel du navigateur, pas juste notre
   * comptabilité interne. */
  connected: boolean;
}

export interface CacheInfo {
  path: string;
  sizeBytes: number;
  fileCount: number;
}

export type BulkAction = 'launch' | 'stop' | 'delete' | 'clear-cache' | 'set-proxy';

export interface BulkResult {
  id: string;
  ok: boolean;
  error?: string;
}

/** Distingue "profil inconnu" (404 côté API) de toute autre erreur (500). */
export class ProfileNotFoundError extends Error {
  constructor(id: string) {
    super(`Profil inconnu: ${id}`);
    this.name = 'ProfileNotFoundError';
  }
}

/**
 * Orchestration au-dessus de `ProfileStore` (persistance) et `DriverBuilder` (lancement) pour
 * des profils NOMMÉS et PERSISTANTS, adressables individuellement — volontairement construit
 * directement sur `DriverBuilder` plutôt que sur `DriverPool` : `DriverPool` modélise des
 * workers anonymes et interchangeables (factory, recyclage), l'exact inverse de "contrôler CE
 * profil précis". `DriverPool` reste inchangé et utile pour son cas d'usage d'origine ailleurs.
 *
 * Le registre des profils actifs (`running`) vit uniquement en mémoire : après un redémarrage
 * du process, tous les profils repartent "arrêtés", même si un navigateur orphelin survivait
 * quelque part (cas limite accepté pour ce v1).
 */
export class ProfileManager {
  private readonly store: ProfileStore;
  private readonly running = new Map<string, BuiltDriver>();

  constructor(store: ProfileStore) {
    this.store = store;
  }

  private toStatus(record: ProfileRecord): ProfileStatus {
    const driver = this.running.get(record.id);
    return {
      ...record,
      running: !!driver,
      connected: !!driver && driver.browser.isConnected(),
    };
  }

  private requireRecord(id: string): ProfileRecord {
    const record = this.store.get(id);
    if (!record) {
      throw new ProfileNotFoundError(id);
    }
    return record;
  }

  list(): ProfileStatus[] {
    return this.store.list().map((r) => this.toStatus(r));
  }

  getDetail(id: string): ProfileStatus {
    return this.toStatus(this.requireRecord(id));
  }

  /** Taille/nombre de fichiers du user-data-dir Playwright — calculé à la demande (pas dans
   * `list()`/`getDetail()`) pour ne pas ralentir la grille avec un parcours disque à chaque poll. */
  getCacheInfo(id: string): CacheInfo {
    this.requireRecord(id);
    const dir = this.store.browserProfileDir(id);
    return { path: dir, ...this.scanDir(dir) };
  }

  private scanDir(dir: string): { sizeBytes: number; fileCount: number } {
    let sizeBytes = 0;
    let fileCount = 0;
    if (!fs.existsSync(dir)) {
      return { sizeBytes, fileCount };
    }
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          fileCount++;
          sizeBytes += fs.statSync(full).size;
        }
      }
    }
    return { sizeBytes, fileCount };
  }

  create(input: CreateProfileInput): ProfileStatus {
    return this.toStatus(this.store.create(input));
  }

  /**
   * Les changements (proxy, device, locale, headless...) ne s'appliquent qu'au PROCHAIN
   * lancement : Playwright ne permet pas de changer la config d'un contexte persistant déjà
   * lancé. Le settings est toujours sauvegardé même si le profil tourne actuellement.
   */
  updateSettings(id: string, patch: UpdateProfileInput): ProfileStatus {
    this.requireRecord(id);
    return this.toStatus(this.store.update(id, patch));
  }

  async launch(id: string): Promise<ProfileStatus> {
    const record = this.requireRecord(id);
    if (this.running.has(id)) {
      return this.toStatus(record); // déjà actif : no-op idempotent
    }
    const builder = new DriverBuilder({
      profileDir: this.store.browserProfileDir(id),
      headless: record.headless,
      device: record.device,
      locale: record.locale,
      timezoneId: record.timezoneId,
      ...(record.proxy ? { proxy: record.proxy } : {}),
      // Filet de sécurité en plus du chemin fixe (cf. driverBuilder.ts) : un profil nommé ne
      // doit jamais être supprimé par quit(), quoi qu'il arrive.
      keepProfile: true,
    });

    try {
      const driver = await builder.build();
      this.running.set(id, driver);
      const updated = this.store.update(id, {
        lastLaunchResult: { at: new Date().toISOString(), ok: true },
      });
      return this.toStatus(updated);
    } catch (err) {
      this.store.update(id, {
        lastLaunchResult: {
          at: new Date().toISOString(),
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  }

  async stop(id: string): Promise<ProfileStatus> {
    const record = this.requireRecord(id);
    const driver = this.running.get(id);
    if (driver) {
      await DriverBuilder.quit(driver.context);
      this.running.delete(id);
    }
    return this.toStatus(record);
  }

  /** Arrête le profil s'il tourne (impossible de vider en toute sécurité le dossier d'un
   * profil actif : fichiers verrouillés par le navigateur), puis vide son contenu. Le record
   * (nom, config) n'est pas touché. */
  async clearCache(id: string): Promise<ProfileStatus> {
    await this.stop(id);
    const dir = this.store.browserProfileDir(id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return this.toStatus(this.requireRecord(id));
  }

  async deleteProfile(id: string): Promise<void> {
    await this.stop(id);
    fs.rmSync(this.store.browserProfileDir(id), { recursive: true, force: true });
    this.store.remove(id);
  }

  /**
   * Applique `action` à chaque id de `ids` indépendamment (`Promise.allSettled`) : un id en
   * échec (profil inconnu, crash au lancement...) ne bloque jamais le traitement des autres —
   * le même principe que `DriverPool`'s `Promise.allSettled` dans `drain()`.
   */
  async bulk(
    ids: string[],
    action: BulkAction,
    opts: { proxy?: ProxyConfig | null } = {}
  ): Promise<BulkResult[]> {
    const runOne = async (id: string): Promise<void> => {
      switch (action) {
        case 'launch':
          await this.launch(id);
          return;
        case 'stop':
          await this.stop(id);
          return;
        case 'clear-cache':
          await this.clearCache(id);
          return;
        case 'delete':
          await this.deleteProfile(id);
          return;
        case 'set-proxy':
          this.updateSettings(id, { proxy: opts.proxy ?? null });
          return;
        default: {
          const exhaustive: never = action;
          throw new Error(`Action groupée inconnue: ${String(exhaustive)}`);
        }
      }
    };

    const results = await Promise.allSettled(ids.map((id) => runOne(id)));
    return results.map((result, i) => ({
      id: ids[i],
      ok: result.status === 'fulfilled',
      ...(result.status === 'rejected'
        ? { error: result.reason instanceof Error ? result.reason.message : String(result.reason) }
        : {}),
    }));
  }
}
