import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { UserRepository } from './db/users';
import type { TeamRepository } from './db/teams';
import type { ProxyRepository } from './db/proxies';
import type { ProfileRepository } from './db/profiles';
import type { RefreshTokenRepository } from './db/refreshTokens';
import type { EmailCodeRepository } from './db/emailCodes';
import type { ProfileStateStore } from './profileState';
import type { PresenceTracker } from './ws/presence';
import { createAuthRouter } from './routes/authRouter';
import { createAccountRouter } from './routes/accountRouter';
import { createTeamsRouter } from './routes/teamsRouter';
import { createProxiesRouter } from './routes/proxiesRouter';
import { createProfilesRouter } from './routes/profilesRouter';
import { UnauthorizedError, ForbiddenError } from './auth/middleware';

export interface AppDeps {
  users: UserRepository;
  teams: TeamRepository;
  proxies: ProxyRepository;
  profiles: ProfileRepository;
  refreshTokens: RefreshTokenRepository;
  emailCodes: EmailCodeRepository;
  state: ProfileStateStore;
  presence: PresenceTracker;
  dataDir: string;
}

/**
 * Backend cloud smonster : auth + teams/membres/permissions + catalogue partagé (profils/
 * proxys) + état des profils. Ne sert plus de dashboard statique (`public/`) — c'est Electron
 * (phase C) qui charge l'UI directement, le cloud n'est qu'une API + WebSocket (cf. plan).
 */
export function createApp(deps: AppDeps) {
  const app = express();
  // `express.json()` ignore les requêtes dont le Content-Type ne correspond pas (ex.
  // `application/gzip` sur `PUT .../profiles/:id/state`, qui a son propre middleware `raw()`
  // scoped à cette seule route dans profilesRouter.ts) — pas de conflit entre les deux.
  app.use(express.json());

  app.use(
    '/api/auth',
    createAuthRouter({ users: deps.users, teams: deps.teams, refreshTokens: deps.refreshTokens, emailCodes: deps.emailCodes, dataDir: deps.dataDir })
  );
  app.use('/api/account', createAccountRouter({ users: deps.users }));
  app.use('/api/teams', createTeamsRouter({ teams: deps.teams, profiles: deps.profiles, state: deps.state }));
  app.use('/api/teams/:teamId/proxies', createProxiesRouter(deps.proxies, deps.teams));
  app.use(
    '/api/teams/:teamId/profiles',
    createProfilesRouter({ profiles: deps.profiles, teams: deps.teams, state: deps.state, presence: deps.presence })
  );

  // Middleware d'erreur central (signature à 4 arguments requise par Express pour être reconnu
  // comme tel) : mappe les erreurs connues en codes HTTP, tout le reste en 500.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof UnauthorizedError) {
      res.status(401).json({ error: err.message });
      return;
    }
    if (err instanceof ForbiddenError) {
      res.status(403).json({ error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('Erreur non gérée sur une requête du backend:', err);
    res.status(500).json({ error: message });
  });

  return app;
}
