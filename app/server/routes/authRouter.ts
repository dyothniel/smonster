import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { UserRepository } from '../db/users';
import type { TeamRepository } from '../db/teams';
import type { RefreshTokenRepository } from '../db/refreshTokens';
import type { EmailCodeRepository } from '../db/emailCodes';
import { verifyPassword, hashPassword } from '../auth/passwords';
import {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  verifyAccessToken,
  signChallengeToken,
  verifyChallengeToken,
} from '../auth/jwt';
import type { AccessTokenPayload } from '../auth/jwt';
import { verifyTotp } from '../auth/totp';
import { tryUnsealTotpSecret } from '../auth/totpSecretBox';
import { generateEmailCode, hashEmailCode, EMAIL_CODE_TTL_MS, EMAIL_CODE_MAX_ATTEMPTS } from '../auth/emailCodes';
import { sendMail } from '../mail/transport';
import { requireAuth, UnauthorizedError } from '../auth/middleware';
import type { AuthedRequest } from '../auth/middleware';
import type { UserRecord } from '../db/users';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Reconstruit le payload JWT à partir de l'état FRAIS en base (teams/rôles à l'instant T). */
function buildAccessPayload(users: UserRepository, teams: TeamRepository, userId: string): AccessTokenPayload {
  const user = users.findById(userId);
  if (!user) {
    throw new Error(`authRouter: utilisateur disparu entre deux étapes d'auth: ${userId}`);
  }
  const memberships = teams.listTeamsForUser(userId);
  return {
    sub: user.id,
    email: user.email,
    displayName: user.displayName,
    isSuperAdmin: user.isSuperAdmin,
    teams: memberships.map((m) => ({ teamId: m.team.id, role: m.role })),
  };
}

/** Termine une connexion (émet les vrais tokens) — partagé entre `/login` (sans 2FA) et
 * `/login/verify` (après un défi réussi), seul le chemin pour y arriver diffère. */
function completeLogin(
  users: UserRepository,
  teams: TeamRepository,
  refreshTokens: RefreshTokenRepository,
  user: UserRecord,
  deviceLabel: string | null
) {
  const accessToken = signAccessToken(buildAccessPayload(users, teams, user.id));
  const { token: refreshToken, hash } = generateRefreshToken();
  refreshTokens.create(user.id, hash, deviceLabel);
  return {
    accessToken,
    refreshToken,
    user: { id: user.id, email: user.email, displayName: user.displayName, isSuperAdmin: user.isSuperAdmin },
  };
}

export function createAuthRouter(deps: {
  users: UserRepository;
  teams: TeamRepository;
  refreshTokens: RefreshTokenRepository;
  emailCodes: EmailCodeRepository;
  dataDir: string;
}): Router {
  const { users, teams, refreshTokens, emailCodes, dataDir } = deps;
  const router = Router();

  router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Record<string, unknown>;
      if (!isNonEmptyString(body.email) || !isNonEmptyString(body.password)) {
        res.status(400).json({ error: '`email` et `password` sont requis.' });
        return;
      }
      const user = users.findByEmail(body.email.trim().toLowerCase());
      // Message volontairement identique que l'email existe ou non — ne pas révéler quels emails
      // sont enregistrés.
      const invalidCredentials = () => res.status(401).json({ error: 'Identifiants invalides.' });
      if (!user || !user.isActive) {
        invalidCredentials();
        return;
      }
      const valid = await verifyPassword(user.passwordHash, body.password);
      if (!valid) {
        invalidCredentials();
        return;
      }

      // 2FA : le mot de passe seul ne suffit pas, renvoie un défi plutôt que des tokens — le
      // TOTP passe avant l'email s'il est activé (pas besoin d'attendre un email si on a déjà
      // son app d'authentification sous la main).
      if (user.totpSecretEnc && user.totpEnabledAt) {
        const challenge = signChallengeToken({ sub: user.id, method: 'totp' });
        res.status(200).json({ mfa: 'totp', challenge });
        return;
      }
      if (user.emailOtpEnabled) {
        const code = generateEmailCode();
        emailCodes.create(user.id, hashEmailCode(code), EMAIL_CODE_TTL_MS);
        // Best-effort : un envoi raté ne doit jamais empêcher la tentative de connexion de
        // démarrer, le prochain `/login/verify` échouera juste naturellement (code invalide).
        sendMail(
          { to: user.email, subject: 'Code de connexion smonster', html: `<p>Ton code de connexion : <b>${code}</b> (valable 10 minutes).</p>` },
          dataDir
        ).catch((err) => console.error('Échec envoi email 2FA:', err));
        const challenge = signChallengeToken({ sub: user.id, method: 'email' });
        res.status(200).json({ mfa: 'email', challenge });
        return;
      }

      const deviceLabel = isNonEmptyString(body.deviceLabel) ? body.deviceLabel : null;
      res.status(200).json(completeLogin(users, teams, refreshTokens, user, deviceLabel));
    } catch (err) {
      next(err);
    }
  });

  /** Second temps de la connexion quand `/login` a renvoyé `{mfa: ...}` — vérifie le code TOTP
   * ou email selon `challenge.method`, puis termine la connexion exactement comme `/login`. */
  router.post('/login/verify', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Record<string, unknown>;
      if (!isNonEmptyString(body.challenge) || !isNonEmptyString(body.code)) {
        res.status(400).json({ error: '`challenge` et `code` sont requis.' });
        return;
      }
      const challenge = verifyChallengeToken(body.challenge);
      const invalidChallenge = () => res.status(401).json({ error: 'Session de connexion expirée, recommence depuis le début.' });
      if (!challenge) {
        invalidChallenge();
        return;
      }
      const user = users.findById(challenge.sub);
      if (!user || !user.isActive) {
        invalidChallenge();
        return;
      }

      const invalidCode = () => res.status(401).json({ error: 'Code invalide.' });
      if (challenge.method === 'totp') {
        if (!user.totpSecretEnc || !user.totpEnabledAt) {
          invalidChallenge();
          return;
        }
        const secret = tryUnsealTotpSecret(user.totpSecretEnc);
        const result = secret ? verifyTotp(secret, body.code, user.totpLastStep) : { valid: false, step: 0 };
        if (!result.valid) {
          invalidCode();
          return;
        }
        users.setTotpLastStep(user.id, result.step);
      } else {
        const pending = emailCodes.findLatestPending(user.id);
        if (!pending || pending.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
          invalidCode();
          return;
        }
        if (pending.codeHash !== hashEmailCode(body.code)) {
          emailCodes.incrementAttempts(pending.id);
          invalidCode();
          return;
        }
        emailCodes.consume(pending.id);
      }

      const deviceLabel = isNonEmptyString(body.deviceLabel) ? body.deviceLabel : null;
      res.status(200).json(completeLogin(users, teams, refreshTokens, user, deviceLabel));
    } catch (err) {
      next(err);
    }
  });

  router.post('/refresh', (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Record<string, unknown>;
      if (!isNonEmptyString(body.refreshToken)) {
        res.status(400).json({ error: '`refreshToken` est requis.' });
        return;
      }
      const hash = hashRefreshToken(body.refreshToken);
      const existing = refreshTokens.findValid(hash);
      if (!existing) {
        res.status(401).json({ error: 'Refresh token invalide, expiré, ou déjà utilisé.' });
        return;
      }
      // Rotation à chaque usage : l'ancien token ne revit jamais, même volé après coup.
      refreshTokens.revoke(existing.id);
      const accessToken = signAccessToken(buildAccessPayload(users, teams, existing.userId));
      const { token: newRefreshToken, hash: newHash } = generateRefreshToken();
      refreshTokens.create(existing.userId, newHash, existing.deviceLabel);
      res.status(200).json({ accessToken, refreshToken: newRefreshToken });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Record<string, unknown>;
      if (isNonEmptyString(body.refreshToken)) {
        const existing = refreshTokens.findValid(hashRefreshToken(body.refreshToken));
        if (existing) refreshTokens.revoke(existing.id);
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', requireAuth, (req: Request, res: Response) => {
    // Reflète le JWT courant, pas un nouvel état DB : c'est exactement ce que les autres
    // middlewares d'autorisation utilisent pour décider des accès (cf. doc de
    // `requireTeamMembership` sur le compromis "à jour seulement après refresh").
    const user = (req as AuthedRequest).user;
    if (!user) {
      throw new UnauthorizedError('requireAuth aurait dû bloquer cette requête.');
    }
    res.status(200).json(user);
  });

  // Pas de `requireAuth` ici (volontaire) : c'est le point d'entrée de création de compte "sur
  // invitation uniquement" (pas d'auto-inscription publique, cf. plan). Deux cas :
  //   - L'email invité n'a pas encore de compte -> crée le compte (nécessite `password`/
  //     `displayName` dans le corps), sans authentification préalable possible par construction.
  //   - L'email invité a déjà un compte -> exige d'être connecté EN TANT que ce compte (le
  //     header Authorization, s'il est présent, doit correspondre au même email) ; on ne laisse
  //     jamais un simple token d'invitation, seul, rattacher une membership à un compte
  //     EXISTANT sans preuve que l'appelant EST ce compte.
  router.post('/accept-invite', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Record<string, unknown>;
      if (!isNonEmptyString(body.token)) {
        res.status(400).json({ error: '`token` est requis.' });
        return;
      }
      const invite = teams.findValidInviteByToken(body.token);
      if (!invite) {
        res.status(400).json({ error: 'Invitation invalide, expirée, ou déjà utilisée.' });
        return;
      }

      let user = users.findByEmail(invite.email);
      if (!user) {
        if (!isNonEmptyString(body.password) || !isNonEmptyString(body.displayName)) {
          res.status(400).json({ error: 'Nouveau compte : `password` et `displayName` sont requis.' });
          return;
        }
        user = users.create({ email: invite.email, passwordHash: await hashPassword(body.password), displayName: body.displayName });
      } else {
        const header = req.headers.authorization;
        const payload = header?.startsWith('Bearer ') ? verifyAccessToken(header.slice('Bearer '.length)) : null;
        if (!payload || payload.email !== user.email) {
          res.status(401).json({ error: 'Ce compte existe déjà : connectez-vous avec ce compte avant d\'accepter l\'invitation.' });
          return;
        }
      }

      if (!teams.getMembership(user.id, invite.teamId)) {
        teams.addMembership(invite.teamId, user.id, invite.role);
      }
      teams.markInviteAccepted(invite.id);

      const accessToken = signAccessToken(buildAccessPayload(users, teams, user.id));
      const { token: refreshToken, hash } = generateRefreshToken();
      refreshTokens.create(user.id, hash, null);
      res.status(200).json({
        accessToken,
        refreshToken,
        user: { id: user.id, email: user.email, displayName: user.displayName, isSuperAdmin: user.isSuperAdmin },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
