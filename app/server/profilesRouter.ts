import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { ProfileManager, BulkAction } from '../profileManager';
import type { ProxyConfig } from '../driverBuilder';
import type { UpdateProfileInput } from '../profileStore';

const BULK_ACTIONS: readonly BulkAction[] = ['launch', 'stop', 'delete', 'clear-cache', 'set-proxy'];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** `undefined` = champ absent (invalide), `null` = pas de proxy, sinon un `ProxyConfig`. */
function parseProxyField(v: unknown): ProxyConfig | null | undefined {
  if (v === null) {
    return null;
  }
  if (typeof v === 'object' && v !== null && isNonEmptyString((v as Record<string, unknown>).server)) {
    const { server, bypass, username, password, rotationUrl } = v as Record<string, unknown>;
    const proxy: ProxyConfig = { server: server as string };
    if (isNonEmptyString(bypass)) proxy.bypass = bypass;
    if (isNonEmptyString(username)) proxy.username = username;
    if (isNonEmptyString(password)) proxy.password = password;
    if (isNonEmptyString(rotationUrl)) proxy.rotationUrl = rotationUrl;
    return proxy;
  }
  return undefined;
}

// Point le middleware `express.json()` de httpServer.ts vers `unknown` plutôt que `any` implicite.
type Body = Record<string, unknown>;

// path-to-regexp v8 (Express 5) type `req.params.<name>` comme `string | string[]` pour couvrir
// les patterns de paramètres répétés (`:id+`) ; notre route `:id` classique ne produit jamais un
// tableau en pratique, mais on le normalise explicitement plutôt que de forcer le type.
function getIdParam(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string') {
    throw new Error('Paramètre `id` invalide.');
  }
  return id;
}

/**
 * Routes fines : validation d'entrée + appel `ProfileManager` + status code. Aucune logique
 * métier ici (elle vit dans `ProfileManager`). Les erreurs sont relayées à `next(err)` (Express
 * 5 le fait même automatiquement pour un handler async qui rejette) et mappées en 404/400/500
 * par le middleware d'erreur central de `httpServer.ts`.
 */
export function createProfilesRouter(manager: ProfileManager): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.json(manager.list());
  });

  router.post('/', (req: Request, res: Response, next: NextFunction) => {
    const body = req.body as Body;
    if (!isNonEmptyString(body.name)) {
      res.status(400).json({ error: '`name` est requis (chaîne non vide).' });
      return;
    }
    try {
      const proxy = 'proxy' in body ? parseProxyField(body.proxy) : undefined;
      if ('proxy' in body && proxy === undefined) {
        res.status(400).json({ error: '`proxy` invalide (attendu: null ou { server, ... }).' });
        return;
      }
      const created = manager.create({
        name: body.name,
        ...(typeof body.headless === 'boolean' ? { headless: body.headless } : {}),
        ...(isNonEmptyString(body.device) ? { device: body.device } : {}),
        ...(isNonEmptyString(body.locale) ? { locale: body.locale } : {}),
        ...(isNonEmptyString(body.timezoneId) ? { timezoneId: body.timezoneId } : {}),
        ...(proxy !== undefined ? { proxy } : {}),
      });
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', (req: Request, res: Response) => {
    res.json(manager.getDetail(getIdParam(req)));
  });

  router.get('/:id/cache', (req: Request, res: Response) => {
    res.json(manager.getCacheInfo(getIdParam(req)));
  });

  router.patch('/:id', (req: Request, res: Response, next: NextFunction) => {
    const body = req.body as Body;
    const patch: UpdateProfileInput = {};
    if ('name' in body) {
      if (!isNonEmptyString(body.name)) {
        res.status(400).json({ error: '`name` doit être une chaîne non vide.' });
        return;
      }
      patch.name = body.name;
    }
    if ('headless' in body) {
      if (typeof body.headless !== 'boolean') {
        res.status(400).json({ error: '`headless` doit être un booléen.' });
        return;
      }
      patch.headless = body.headless;
    }
    if ('device' in body) {
      if (!isNonEmptyString(body.device)) {
        res.status(400).json({ error: '`device` doit être une chaîne non vide.' });
        return;
      }
      patch.device = body.device;
    }
    if ('locale' in body) {
      if (!isNonEmptyString(body.locale)) {
        res.status(400).json({ error: '`locale` doit être une chaîne non vide.' });
        return;
      }
      patch.locale = body.locale;
    }
    if ('timezoneId' in body) {
      if (!isNonEmptyString(body.timezoneId)) {
        res.status(400).json({ error: '`timezoneId` doit être une chaîne non vide.' });
        return;
      }
      patch.timezoneId = body.timezoneId;
    }
    if ('proxy' in body) {
      const proxy = parseProxyField(body.proxy);
      if (proxy === undefined) {
        res.status(400).json({ error: '`proxy` invalide (attendu: null ou { server, ... }).' });
        return;
      }
      patch.proxy = proxy;
    }

    try {
      res.json(manager.updateSettings(getIdParam(req), patch));
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', (req: Request, res: Response, next: NextFunction) => {
    manager
      .deleteProfile(getIdParam(req))
      .then(() => res.status(204).end())
      .catch(next);
  });

  router.post('/:id/launch', (req: Request, res: Response, next: NextFunction) => {
    manager
      .launch(getIdParam(req))
      .then((status) => res.json(status))
      .catch(next);
  });

  router.post('/:id/stop', (req: Request, res: Response, next: NextFunction) => {
    manager
      .stop(getIdParam(req))
      .then((status) => res.json(status))
      .catch(next);
  });

  router.post('/:id/clear-cache', (req: Request, res: Response, next: NextFunction) => {
    manager
      .clearCache(getIdParam(req))
      .then((status) => res.json(status))
      .catch(next);
  });

  router.post('/bulk', (req: Request, res: Response, next: NextFunction) => {
    const body = req.body as Body;
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isNonEmptyString)) {
      res.status(400).json({ error: '`ids` doit être un tableau non vide de chaînes.' });
      return;
    }
    if (!BULK_ACTIONS.includes(body.action as BulkAction)) {
      res.status(400).json({ error: `\`action\` doit être l'une de: ${BULK_ACTIONS.join(', ')}.` });
      return;
    }
    const action = body.action as BulkAction;

    let proxy: ProxyConfig | null | undefined;
    if (action === 'set-proxy') {
      proxy = parseProxyField(body.proxy);
      if (proxy === undefined) {
        res.status(400).json({ error: '`proxy` invalide pour l\'action `set-proxy`.' });
        return;
      }
    }

    manager
      .bulk(ids, action, { proxy })
      .then((results) => res.json(results))
      .catch(next);
  });

  return router;
}
