import { Router, raw } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { ProfileRepository, CreateProfileInput } from '../db/profiles';
import type { ProfileStateStore } from '../profileState';
import type { PresenceTracker } from '../ws/presence';
import { requireAuth, requireTeamMembership, requirePermission } from '../auth/middleware';
import type { TeamRepository } from '../db/teams';
import type { AuthedRequest } from '../auth/middleware';
import { getParam } from './params';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function parseProfileInput(body: Record<string, unknown>): CreateProfileInput | null {
  if (!isNonEmptyString(body.name)) return null;
  return {
    name: body.name.trim(),
    device: isNonEmptyString(body.device) ? body.device : undefined,
    locale: isNonEmptyString(body.locale) ? body.locale : undefined,
    timezoneId: isNonEmptyString(body.timezoneId) ? body.timezoneId : undefined,
    headlessDefault: typeof body.headlessDefault === 'boolean' ? body.headlessDefault : undefined,
    proxyId: body.proxyId === null ? null : isNonEmptyString(body.proxyId) ? body.proxyId : undefined,
  };
}

/**
 * Monté sous `/api/teams/:teamId/profiles` — catalogue METADATA partagé. Plus de `launch`/
 * `stop`/`clear-cache` ici (cf. plan) : le cloud ne lance jamais de navigateur, ça reste
 * entièrement côté Electron (phase C). Les seules actions "actives" ici sont le CRUD de la
 * config et l'aller-retour de l'archive d'état (cookies/sessions).
 */
export function createProfilesRouter(deps: {
  profiles: ProfileRepository;
  teams: TeamRepository;
  state: ProfileStateStore;
  presence: PresenceTracker;
}): Router {
  const { profiles, teams, state, presence } = deps;
  const router = Router({ mergeParams: true });
  router.use(requireAuth, requireTeamMembership);

  router.get('/', (req: Request, res: Response) => {
    const list = profiles.list(getParam(req, 'teamId'));
    const inUse = presence.snapshotForTeam(list.map((p) => p.id));
    res.status(200).json(
      list.map((p) => ({
        ...p,
        inUseBy: inUse[p.id] ? { userId: inUse[p.id].userId, machineLabel: inUse[p.id].machineLabel } : null,
      }))
    );
  });

  router.get('/:id', (req: Request, res: Response) => {
    const profile = profiles.get(getParam(req, 'teamId'), getParam(req, 'id'));
    if (!profile) {
      res.status(404).json({ error: 'Profil introuvable.' });
      return;
    }
    const inUse = presence.get(profile.id);
    res.status(200).json({ ...profile, inUseBy: inUse ? { userId: inUse.userId, machineLabel: inUse.machineLabel } : null });
  });

  router.post('/', requirePermission(teams, 'profiles:create'), (req: Request, res: Response) => {
    const input = parseProfileInput(req.body as Record<string, unknown>);
    if (!input) {
      res.status(400).json({ error: '`name` est requis.' });
      return;
    }
    const created = profiles.create(getParam(req, 'teamId'), (req as AuthedRequest).user!.sub, input);
    res.status(201).json(created);
  });

  router.patch('/:id', requirePermission(teams, 'profiles:edit'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = profiles.update(getParam(req, 'teamId'), getParam(req, 'id'), req.body as Record<string, unknown>);
      res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', requirePermission(teams, 'profiles:delete'), (req: Request, res: Response) => {
    const id = getParam(req, 'id');
    profiles.remove(getParam(req, 'teamId'), id);
    state.remove(id);
    res.status(204).end();
  });

  // --- État réel du profil (cookies/Local Storage/IndexedDB), cf. doc du plan ---------------
  // Lecture/écriture ouvertes à tout membre de la team (pas de `requirePermission` ici) : l'état
  // suit l'USAGE d'un profil, pas son édition — un simple MEMBER doit pouvoir lancer/fermer un
  // profil partagé sans avoir la permission `profiles:edit`.

  router.get('/:id/state', (req: Request, res: Response) => {
    const data = state.read(getParam(req, 'id'));
    if (!data) {
      res.status(404).json({ error: "Aucun état enregistré pour ce profil (premier lancement)." });
      return;
    }
    res.status(200).set('Content-Type', 'application/gzip').send(data);
  });

  router.put(
    '/:id/state',
    raw({ type: 'application/gzip', limit: '100mb' }),
    (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          res.status(400).json({ error: 'Corps de requête vide ou mal typé (attendu: application/gzip).' });
          return;
        }
        const id = getParam(req, 'id');
        state.write(id, req.body);
        const updated = profiles.bumpStateVersion(getParam(req, 'teamId'), id);
        res.status(200).json({ stateVersion: updated.stateVersion, stateUpdatedAt: updated.stateUpdatedAt });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
