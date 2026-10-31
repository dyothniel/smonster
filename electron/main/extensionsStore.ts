import * as fs from 'fs';
import * as path from 'path';

/**
 * Liste des dossiers d'extensions non empaquetées par profil, LOCALE à cette machine - jamais
 * synchronisée vers le cloud (cf. doc de `DriverBuilderOptions.extensionPaths`) : un chemin de
 * dossier choisi par un membre de l'équipe n'a aucun sens sur la machine d'un autre membre.
 * Même esprit que les dossiers `browser-profiles/<id>` eux-mêmes (déjà non synchronisés).
 */
export class ExtensionsStore {
  private readonly filePath: string;
  private data: Record<string, string[]>;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, 'profile-extensions.json');
    this.data = this.load();
  }

  private load(): Record<string, string[]> {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, string[]>;
    } catch {
      return {}; // fichier absent (première utilisation) ou corrompu : repartir à vide, jamais fatal
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  get(profileId: string): string[] {
    return this.data[profileId] ?? [];
  }

  set(profileId: string, extensionPaths: string[]): void {
    if (extensionPaths.length === 0) {
      delete this.data[profileId];
    } else {
      this.data[profileId] = extensionPaths;
    }
    this.save();
  }
}
