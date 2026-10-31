import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { ProxyRepository, CreateProxyInput } from '../db/proxies';
import { requireAuth, requireTeamMembership, requirePermission } from '../auth/middleware';
import type { TeamRepository } from '../db/teams';
import type { AuthedRequest } from '../auth/middleware';
import { getParam } from './params';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function parseProxyInput(body: Record<string, unknown>): CreateProxyInput | null {
  if (!isNonEmptyString(body.label) || !isNonEmptyString(body.server)) return null;
  return {
    label: body.label.trim(),
    server: body.server.trim(),
    username: isNonEmptyString(body.username) ? body.username : null,
    password: isNonEmptyString(body.password) ? body.password : null,
    bypass: isNonEmptyString(body.bypass) ? body.bypass : null,
  };
}

/** Monté sous `/api/teams/:teamId/proxies` — routes fines, délégation à `ProxyRepository`. */
export function createProxiesRouter(proxies: ProxyRepository, teams: TeamRepository): Router {
  const router = Router({ mergeParams: true });
  router.use(requireAuth, requireTeamMembership);

  router.get('/', (req: Request, res: Response) => {
    // Jamais de mot de passe en clair dans une liste — seulement sur un `GET` d'un proxy précis,
    // où l'appelant a explicitement demandé CE proxy (toujours exposé, pas de raison de le
    // cacher à un membre qui a le droit de voir le proxy du tout — mais limiter l'exposition
    // "en masse" reste une bonne pratique par défaut).
    res.status(200).json(proxies.list(getParam(req, 'teamId')).map(({ password, ...rest }) => rest));
  });

  router.get('/:id', (req: Request, res: Response) => {
    const proxy = proxies.get(getParam(req, 'teamId'), getParam(req, 'id'));
    if (!proxy) {
      res.status(404).json({ error: 'Proxy introuvable.' });
      return;
    }
    res.status(200).json(proxy);
  });

  router.post('/', requirePermission(teams, 'proxies:create'), (req: Request, res: Response) => {
    const input = parseProxyInput(req.body as Record<string, unknown>);
    if (!input) {
      res.status(400).json({ error: '`label` et `server` sont requis.' });
      return;
    }
    const created = proxies.create(getParam(req, 'teamId'), (req as AuthedRequest).user!.sub, input);
    res.status(201).json(created);
  });

  router.patch('/:id', requirePermission(teams, 'proxies:edit'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = proxies.update(getParam(req, 'teamId'), getParam(req, 'id'), req.body as Record<string, unknown>);
      res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', requirePermission(teams, 'proxies:delete'), (req: Request, res: Response) => {
    proxies.remove(getParam(req, 'teamId'), getParam(req, 'id'));
    res.status(204).end();
  });

  return router;
}
