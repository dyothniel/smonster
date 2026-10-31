import { Router } from 'express';
import type { Request, Response } from 'express';
import type { TeamRepository } from '../db/teams';
import type { ProfileRepository } from '../db/profiles';
import type { ProfileStateStore } from '../profileState';
import type { MembershipRole } from '../auth/jwt';
import { requireAuth, requireTeamMembership, requireTeamAdmin } from '../auth/middleware';
import type { AuthedRequest } from '../auth/middleware';
import { getParam } from './params';

const PERMISSIONS = ['profiles:create', 'profiles:edit', 'profiles:delete', 'proxies:create', 'proxies:edit', 'proxies:delete'] as const;
type Permission = (typeof PERMISSIONS)[number];
function isPermission(v: string): v is Permission {
  return (PERMISSIONS as readonly string[]).includes(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}
function isMembershipRole(v: unknown): v is MembershipRole {
  return v === 'TEAM_ADMIN' || v === 'MEMBER';
}

function currentUserId(req: Request): string {
  return (req as AuthedRequest).user!.sub;
}

/** Routes fines : validation + délégation à `TeamRepository`, même convention que profilesRouter.ts. */
export function createTeamsRouter(deps: { teams: TeamRepository; profiles: ProfileRepository; state: ProfileStateStore }): Router {
  const { teams, profiles, state } = deps;
  const router = Router();
  router.use(requireAuth);

  router.post('/', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    if (!isNonEmptyString(body.name)) {
      res.status(400).json({ error: '`name` est requis.' });
      return;
    }
    const team = teams.createTeam(body.name.trim(), currentUserId(req));
    res.status(201).json(team);
  });

  router.get('/', (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user!;
    res.status(200).json(teams.listTeamsForUser(user.sub));
  });

  router.get('/:teamId', requireTeamMembership, (req: Request, res: Response) => {
    const team = teams.getTeam(getParam(req, 'teamId'));
    if (!team) {
      res.status(404).json({ error: 'Team introuvable.' });
      return;
    }
    res.status(200).json(team);
  });

  router.get('/:teamId/members', requireTeamMembership, (req: Request, res: Response) => {
    res.status(200).json(teams.listMembers(getParam(req, 'teamId')));
  });

  router.patch('/:teamId', requireTeamAdmin, (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    if (!isNonEmptyString(body.name)) {
      res.status(400).json({ error: '`name` est requis.' });
      return;
    }
    res.status(200).json(teams.renameTeam(getParam(req, 'teamId'), body.name.trim()));
  });

  // Zone de danger : supprime l'équipe ET son contenu (profils/proxys/invitations/membres).
  // Les lignes DB passent par une transaction (TeamRepository.deleteTeam) ; les archives d'état
  // des profils (cookies/sessions, hors DB, cf. profileState.ts) sont nettoyées ici une fois la
  // transaction DB confirmée, par le même chemin que la suppression d'un profil seul
  // (profilesRouter.ts: `state.remove(id)`).
  router.delete('/:teamId', requireTeamAdmin, (req: Request, res: Response) => {
    const teamId = getParam(req, 'teamId');
    const teamProfiles = profiles.list(teamId);
    teams.deleteTeam(teamId);
    for (const profile of teamProfiles) state.remove(profile.id);
    res.status(204).end();
  });

  router.post('/:teamId/invites', requireTeamAdmin, (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    if (!isNonEmptyString(body.email) || !isMembershipRole(body.role)) {
      res.status(400).json({ error: '`email` (chaîne) et `role` (TEAM_ADMIN|MEMBER) sont requis.' });
      return;
    }
    const { invite, token } = teams.createInvite(getParam(req, 'teamId'), body.email.trim().toLowerCase(), body.role, currentUserId(req));
    // MVP : pas d'envoi d'email (aucun SMTP en place) — le TEAM_ADMIN copie-colle ce token/lien
    // lui-même à la personne invitée. Upgradable plus tard sans changer le schéma.
    res.status(201).json({ inviteId: invite.id, token, expiresAt: invite.expiresAt });
  });

  router.patch('/:teamId/members/:membershipId', requireTeamAdmin, (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    if (!isMembershipRole(body.role)) {
      res.status(400).json({ error: '`role` (TEAM_ADMIN|MEMBER) est requis.' });
      return;
    }
    teams.updateMembershipRole(getParam(req, 'membershipId'), body.role);
    res.status(200).json(teams.listMembers(getParam(req, 'teamId')));
  });

  router.delete('/:teamId/members/:membershipId', requireTeamAdmin, (req: Request, res: Response) => {
    teams.removeMembership(getParam(req, 'membershipId'));
    res.status(204).end();
  });

  router.put('/:teamId/members/:membershipId/permissions/:permission', requireTeamAdmin, (req: Request, res: Response) => {
    const permission = getParam(req, 'permission');
    if (!isPermission(permission)) {
      res.status(400).json({ error: `Permission inconnue : ${permission}` });
      return;
    }
    teams.grantPermission(getParam(req, 'membershipId'), permission, currentUserId(req));
    res.status(200).json(teams.listMembers(getParam(req, 'teamId')));
  });

  router.delete('/:teamId/members/:membershipId/permissions/:permission', requireTeamAdmin, (req: Request, res: Response) => {
    const permission = getParam(req, 'permission');
    if (!isPermission(permission)) {
      res.status(400).json({ error: `Permission inconnue : ${permission}` });
      return;
    }
    teams.revokePermission(getParam(req, 'membershipId'), permission);
    res.status(200).json(teams.listMembers(getParam(req, 'teamId')));
  });

  return router;
}
