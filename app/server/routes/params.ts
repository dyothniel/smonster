import type { Request } from 'express';

// path-to-regexp v8 (Express 5) type `req.params.<name>` comme `string | string[]` pour couvrir
// les patterns de paramètres répétés (`:id+`) — même piège déjà rencontré dans l'ancien
// profilesRouter.ts. Toutes nos routes utilisent des paramètres simples (`:id`, `:teamId`...),
// qui ne produisent jamais un tableau en pratique ; on le normalise explicitement ici plutôt que
// de forcer le type à chaque site d'appel.
export function getParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string') {
    throw new Error(`Paramètre \`${name}\` invalide ou manquant sur cette route.`);
  }
  return value;
}
