import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { DriverBuilderOptions, ProxyConfig } from './driverBuilder';

export interface ProfileRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  headless: boolean;
  device: NonNullable<DriverBuilderOptions['device']>;
  locale: string;
  timezoneId: string;
  proxy: ProxyConfig | null;
  lastLaunchResult?: { at: string; ok: boolean; error?: string };
}

export interface CreateProfileInput {
  name: string;
  headless?: boolean;
  device?: NonNullable<DriverBuilderOptions['device']>;
  locale?: string;
  timezoneId?: string;
  proxy?: ProxyConfig | null;
}

export type UpdateProfileInput = Partial<Omit<ProfileRecord, 'id' | 'createdAt' | 'updatedAt'>>;

/**
 * Persistance des profils nommés : un seul fichier index JSON (`profiles.json`) plutôt qu'un
 * fichier par profil — à cette échelle (usage interne, quelques dizaines de profils), une
 * lecture unique pour la grille du dashboard bat N lectures, et le fichier reste inspectable/
 * éditable à la main en cas de pépin.
 *
 * Toutes les méthodes sont volontairement **synchrones** (fs.*Sync) : Node étant mono-thread,
 * une opération synchrone ne peut jamais être interrompue par une autre requête HTTP concurrente
 * au milieu d'un cycle lecture-modification-écriture — pas besoin d'un verrou explicite pour
 * sérialiser les écritures tant qu'on reste sur ce modèle (un seul process, un seul writer).
 *
 * L'écriture est atomique (fichier temporaire + rename) pour éviter un `profiles.json` corrompu
 * si le process est tué en plein milieu d'une écriture.
 */
export class ProfileStore {
  private readonly indexPath: string;
  private readonly browserProfilesRoot: string;
  private records: ProfileRecord[];

  constructor(dataDir: string) {
    this.indexPath = path.join(dataDir, 'profiles.json');
    this.browserProfilesRoot = path.join(dataDir, 'browser-profiles');
    fs.mkdirSync(this.browserProfilesRoot, { recursive: true });
    this.records = this.load();
  }

  private load(): ProfileRecord[] {
    if (!fs.existsSync(this.indexPath)) {
      return [];
    }
    const raw = fs.readFileSync(this.indexPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`ProfileStore: ${this.indexPath} illisible (JSON invalide) : ${err}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`ProfileStore: ${this.indexPath} ne contient pas un tableau de profils.`);
    }
    return parsed as ProfileRecord[];
  }

  private persist(): void {
    const tmpPath = `${this.indexPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.records, null, 2));
    fs.renameSync(tmpPath, this.indexPath);
  }

  /** Chemin du user-data-dir Playwright pour ce profil (dérivé de l'id, jamais stocké). */
  browserProfileDir(id: string): string {
    return path.join(this.browserProfilesRoot, id);
  }

  list(): ProfileRecord[] {
    return this.records.map((r) => ({ ...r }));
  }

  get(id: string): ProfileRecord | undefined {
    const record = this.records.find((r) => r.id === id);
    return record ? { ...record } : undefined;
  }

  create(input: CreateProfileInput): ProfileRecord {
    const now = new Date().toISOString();
    const record: ProfileRecord = {
      id: randomUUID(),
      name: input.name,
      createdAt: now,
      updatedAt: now,
      headless: input.headless ?? true, // défaut pensé pour un déploiement VPS sans display
      device: input.device ?? 'desktop',
      locale: input.locale ?? 'fr-FR',
      timezoneId: input.timezoneId ?? 'Europe/Paris',
      proxy: input.proxy ?? null,
    };
    this.records.push(record);
    this.persist();
    return { ...record };
  }

  update(id: string, patch: UpdateProfileInput): ProfileRecord {
    const idx = this.records.findIndex((r) => r.id === id);
    if (idx === -1) {
      throw new Error(`ProfileStore: profil inconnu: ${id}`);
    }
    const updated: ProfileRecord = {
      ...this.records[idx],
      ...patch,
      id: this.records[idx].id,
      createdAt: this.records[idx].createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.records[idx] = updated;
    this.persist();
    return { ...updated };
  }

  /** No-op défensif si l'id est inconnu, cohérent avec `DriverPool.release()` sur un driver inconnu. */
  remove(id: string): void {
    const idx = this.records.findIndex((r) => r.id === id);
    if (idx === -1) {
      return;
    }
    this.records.splice(idx, 1);
    this.persist();
  }
}
