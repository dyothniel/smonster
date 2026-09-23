import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import * as path from 'path';
import { ProfileManager, ProfileNotFoundError } from '../profileManager';
import { createProfilesRouter } from './profilesRouter';

export interface CreateAppOptions {
  /**
   * Dossier des fichiers statiques du dashboard. Par défaut, le dossier `public/` à la racine
   * du repo (résolu depuis le fichier compilé, PAS copié dans `dist/` — `public/` ne contient
   * aucun `.ts`, donc `tsconfig.json` n'a rien à en faire).
   */
  publicDir?: string;
}

export function createApp(manager: ProfileManager, opts: CreateAppOptions = {}) {
  const app = express();
  app.use(express.json());

  const publicDir = opts.publicDir ?? path.join(__dirname, '..', '..', 'public');
  app.use(express.static(publicDir));

  app.use('/api/profiles', createProfilesRouter(manager));

  // Middleware d'erreur central (signature à 4 arguments requise par Express pour être reconnu
  // comme tel) : mappe ProfileNotFoundError en 404, tout le reste en 500.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ProfileNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('Erreur non gérée sur une requête du dashboard:', err);
    res.status(500).json({ error: message });
  });

  return app;
}
