import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from './jwt';
import type { AccessTokenPayload } from './jwt';
import type { TeamRepository } from '../db/teams';

export class UnauthorizedError extends Error {}
export class ForbiddenError extends Error {}

export interface AuthedRequest extends Request {
  user?: AccessTokenPayload;
}

function getUser(req: Request): AccessTokenPayload {
  const user = (req as AuthedRequest).user;
  if (!user) {
    // Ne devrait jamais arriver si `requireAuth` tourne toujours avant — garde-fou, pas un cas
    // métier normal.
    throw new Error('requireAuth doit s\'exécuter avant tout middleware de permission.');
  }
  return user;
}

function getTeamIdParam(req: Request): string {
  const teamId = req.params.teamId;
  if (typeof teamId !== 'string') {
    throw new Error('Paramètre `teamId` manquant sur cette route.');
  }
  return teamId;
}

/** Vérifie le JWT d'accès (`Authorization: Bearer <token>`), attache le payload à `req.user`. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    next(new UnauthorizedError('En-tête Authorization manquant ou mal formé.'));
    return;
  }
  const payload = verifyAccessToken(header.slice('Bearer '.length));
  if (!payload) {
    next(new UnauthorizedError('Token invalide ou expiré.'));
    return;
  }
  (req as AuthedRequest).user = payload;
  next();
}

/** Réservé au `SUPER_ADMIN` (propriétaire de la plateforme) — pour des actions qui ne sont scopées
 * à AUCUNE team, ex. réinitialiser la 2FA d'un compte verrouillé (cf. accountRouter.ts). */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction): void {
  const user = getUser(req);
  if (user.isSuperAdmin) {
    next();
    return;
  }
  next(new ForbiddenError('Réservé au SUPER_ADMIN.'));
}

/** Doit tourner après `requireAuth`, sur une route `/api/teams/:teamId/...`. */
export function requireTeamMembership(req: Request, _res: Response, next: NextFunction): void {
  const user = getUser(req);
  const teamId = getTeamIdParam(req);
  if (user.isSuperAdmin || user.teams.some((t) => t.teamId === teamId)) {
    next();
    return;
  }
  next(new ForbiddenError('Vous n\'appartenez pas à cette team.'));
}

/** Réservé au TEAM_ADMIN de la team visée (ou à un SUPER_ADMIN, qui passe toujours). */
export function requireTeamAdmin(req: Request, _res: Response, next: NextFunction): void {
  const user = getUser(req);
  if (user.isSuperAdmin) {
    next();
    return;
  }
  const teamId = getTeamIdParam(req);
  const membership = user.teams.find((t) => t.teamId === teamId);
  if (membership?.role === 'TEAM_ADMIN') {
    next();
    return;
  }
  next(new ForbiddenError('Réservé au TEAM_ADMIN de cette team.'));
}

/**
 * Vérifie une permission granulaire par-membre (cf. `member_permissions`) — un `TEAM_ADMIN` ou
 * `SUPER_ADMIN` passe toujours (ils ont tous les droits par construction, non restreignables) ;
 * un `MEMBER` doit avoir la permission explicitement accordée. Lue EN DIRECT depuis la base à
 * chaque requête (pas depuis le JWT, qui ne porte que le rôle) : un retrait de permission par le
 * `TEAM_ADMIN` doit prendre effet immédiatement, pas attendre le prochain refresh de token.
 */
export function requirePermission(teamRepo: TeamRepository, permission: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = getUser(req);
    if (user.isSuperAdmin) {
      next();
      return;
    }
    const teamId = getTeamIdParam(req);
    const membership = user.teams.find((t) => t.teamId === teamId);
    if (!membership) {
      next(new ForbiddenError('Vous n\'appartenez pas à cette team.'));
      return;
    }
    if (membership.role === 'TEAM_ADMIN') {
      next();
      return;
    }
    const dbMembership = teamRepo.getMembership(user.sub, teamId);
    const granted = dbMembership ? teamRepo.getPermissions(dbMembership.id) : [];
    if (!granted.includes(permission)) {
      next(new ForbiddenError(`Permission manquante : ${permission}`));
      return;
    }
    next();
  };
}
