import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import * as QRCode from 'qrcode';
import type { UserRepository } from '../db/users';
import { verifyPassword, hashPassword } from '../auth/passwords';
import { generateTotpSecret, buildTotpUri, verifyTotp } from '../auth/totp';
import { sealTotpSecret, tryUnsealTotpSecret } from '../auth/totpSecretBox';
import { canSendMail } from '../mail/transport';
import { requireAuth, requireSuperAdmin, UnauthorizedError } from '../auth/middleware';
import type { AuthedRequest } from '../auth/middleware';
import { getParam } from './params';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Récupère l'utilisateur FRAIS en base pour la requête courante (le JWT ne porte qu'un instantané
 * à l'émission, pas l'état 2FA — toujours relu ici, jamais fait confiance au token pour ça). */
function currentUser(users: UserRepository, req: Request) {
  const claims = (req as AuthedRequest).user;
  if (!claims) throw new UnauthorizedError('requireAuth aurait dû bloquer cette requête.');
  const user = users.findById(claims.sub);
  if (!user) throw new UnauthorizedError('Compte introuvable.');
  return user;
}

/**
 * Mon compte : profil, mot de passe, 2FA (TOTP + email). Volontairement PAS scopé à une team
 * (monté sur `/api/account`, pas `/api/teams/:teamId/...`) — ce sont des propriétés du COMPTE,
 * pas d'une appartenance à une équipe (cf. `requireSuperAdmin` plutôt que `requireTeamAdmin` pour
 * la réinitialisation 2FA d'un compte tiers, en bas de ce fichier).
 */
export function createAccountRouter(deps: { users: UserRepository }): Router {
  const { users } = deps;
  const router = Router();
  router.use(requireAuth);

  router.get('/', (req: Request, res: Response) => {
    const user = currentUser(users, req);
    res.status(200).json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      totpEnabled: !!(user.totpSecretEnc && user.totpEnabledAt),
      emailOtpEnabled: user.emailOtpEnabled,
      canSendMail: canSendMail(),
    });
  });

  router.patch('/', (req: Request, res: Response) => {
    const user = currentUser(users, req);
    const body = req.body as Record<string, unknown>;
    if (!isNonEmptyString(body.displayName)) {
      res.status(400).json({ error: '`displayName` est requis.' });
      return;
    }
    users.updateDisplayName(user.id, body.displayName.trim());
    res.status(200).json({ ok: true });
  });

  router.post('/password', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = currentUser(users, req);
      const body = req.body as Record<string, unknown>;
      if (!isNonEmptyString(body.currentPassword) || !isNonEmptyString(body.newPassword)) {
        res.status(400).json({ error: '`currentPassword` et `newPassword` sont requis.' });
        return;
      }
      if (body.newPassword.length < 10) {
        res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 10 caractères.' });
        return;
      }
      if (!(await verifyPassword(user.passwordHash, body.currentPassword))) {
        res.status(401).json({ error: 'Mot de passe actuel incorrect.' });
        return;
      }
      users.updatePasswordHash(user.id, await hashPassword(body.newPassword));
      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // --- 2FA : application d'authentification (TOTP) -------------------------------------------

  router.post('/totp/setup', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = currentUser(users, req);
      const secret = generateTotpSecret();
      users.setPendingTotpSecret(user.id, sealTotpSecret(secret));
      const uri = buildTotpUri(secret, user.email);
      const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
      res.status(200).json({ secret, uri, qrDataUrl });
    } catch (err) {
      next(err);
    }
  });

  router.post('/totp/enable', (req: Request, res: Response) => {
    const user = currentUser(users, req);
    const body = req.body as Record<string, unknown>;
    if (!user.totpSecretEnc) {
      res.status(400).json({ error: "Démarre d'abord l'activation (`/totp/setup`)." });
      return;
    }
    if (!isNonEmptyString(body.code)) {
      res.status(400).json({ error: '`code` est requis.' });
      return;
    }
    const secret = tryUnsealTotpSecret(user.totpSecretEnc);
    const result = secret ? verifyTotp(secret, body.code, null) : { valid: false, step: 0 };
    if (!result.valid) {
      res.status(401).json({ error: 'Code invalide.' });
      return;
    }
    users.enableTotp(user.id);
    users.setTotpLastStep(user.id, result.step);
    res.status(200).json({ ok: true });
  });

  // Mot de passe (pas un code TOTP) pour désactiver : perdre son téléphone ne doit jamais
  // verrouiller le compte — cf. doc du plan 2FA.
  router.post('/totp/disable', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = currentUser(users, req);
      const body = req.body as Record<string, unknown>;
      if (!isNonEmptyString(body.password)) {
        res.status(400).json({ error: '`password` est requis.' });
        return;
      }
      if (!(await verifyPassword(user.passwordHash, body.password))) {
        res.status(401).json({ error: 'Mot de passe incorrect.' });
        return;
      }
      users.disableTotp(user.id);
      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // --- 2FA : code par email ---------------------------------------------------------------------

  router.patch('/security', (req: Request, res: Response) => {
    const user = currentUser(users, req);
    const body = req.body as Record<string, unknown>;
    if (typeof body.emailOtpEnabled !== 'boolean') {
      res.status(400).json({ error: '`emailOtpEnabled` (booléen) est requis.' });
      return;
    }
    if (body.emailOtpEnabled && !canSendMail()) {
      res.status(503).json({ error: "Envoi d'email non configuré côté serveur (SMTP_HOST manquant)." });
      return;
    }
    users.setEmailOtpEnabled(user.id, body.emailOtpEnabled);
    res.status(200).json({ ok: true });
  });

  // --- Garde-fou SUPER_ADMIN : compte verrouillé (téléphone perdu...) sans accès aux mails ------

  router.post('/users/:userId/reset-2fa', requireSuperAdmin, (req: Request, res: Response) => {
    const userId = getParam(req, 'userId');
    const target = users.findById(userId);
    if (!target) {
      res.status(404).json({ error: 'Utilisateur introuvable.' });
      return;
    }
    users.disableTotp(target.id);
    users.setEmailOtpEnabled(target.id, false);
    res.status(200).json({ ok: true });
  });

  return router;
}
