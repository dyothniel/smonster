import * as fs from 'fs';
import * as path from 'path';

/**
 * Stockage de l'état réel d'un profil (archive cookies/Local Storage/IndexedDB, cf. plan —
 * section "Synchronisation de l'état du profil") : un fichier par profil sur disque, PAS en
 * BLOB SQLite — ces archives restent petites (on exclut déjà le cache HTTP/GPU), mais les garder
 * hors du fichier `.sqlite` le garde petit et rapide à sauvegarder/répliquer.
 *
 * Le contenu de l'archive lui-même (quels fichiers du profil Chromium/WebKit elle contient) est
 * décidé côté Electron (`electron/main/profileManager.ts`, phase C) — ce module ne fait QUE
 * stocker/servir un blob opaque, il ne connaît rien de la structure interne d'un profil
 * navigateur.
 */
export class ProfileStateStore {
  constructor(private readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  private filePath(profileId: string): string {
    return path.join(this.root, `${profileId}.tar.gz`);
  }

  exists(profileId: string): boolean {
    return fs.existsSync(this.filePath(profileId));
  }

  read(profileId: string): Buffer | undefined {
    const file = this.filePath(profileId);
    return fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  }

  /** Écriture atomique (fichier temporaire + rename), même raison que `ProfileStore.persist()`. */
  write(profileId: string, data: Buffer): void {
    const file = this.filePath(profileId);
    const tmpPath = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, file);
  }

  remove(profileId: string): void {
    const file = this.filePath(profileId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
