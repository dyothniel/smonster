import * as fs from 'fs';
import * as path from 'path';
import nodemailer from 'nodemailer';

export class MailNotConfiguredError extends Error {}

function isMailConfigured(): boolean {
  return !!process.env.SMTP_HOST;
}

/** Vrai si on peut réellement envoyer un email MAINTENANT (prod avec SMTP) OU qu'on est en dev
 * (où l'absence de SMTP ne bloque rien, cf. `sendMail` — simulation sur disque). Utilisé pour
 * décider si on autorise l'ACTIVATION de la 2FA par email côté `/account/security`. */
export function canSendMail(): boolean {
  return isMailConfigured() || process.env.NODE_ENV !== 'production';
}

let cachedTransport: ReturnType<typeof nodemailer.createTransport> | null = null;
function getTransport() {
  if (!cachedTransport) {
    cachedTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return cachedTransport;
}

/**
 * Sans SMTP configuré : en dev, écrit l'email dans `<dataDir>/mail-outbox/` plutôt que
 * d'échouer — permet de tester tout le flux 2FA par email en local sans vrai serveur SMTP. En
 * production sans SMTP configuré : échoue explicitement (jamais un succès simulé qui laisserait
 * croire qu'un code a été envoyé alors qu'il ne l'a pas été).
 */
export async function sendMail(opts: { to: string; subject: string; html: string }, dataDir: string): Promise<void> {
  if (!isMailConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      throw new MailNotConfiguredError('SMTP non configuré côté serveur.');
    }
    const outboxDir = path.join(dataDir, 'mail-outbox');
    fs.mkdirSync(outboxDir, { recursive: true });
    const safeTo = opts.to.replace(/[^a-z0-9@.]/gi, '_');
    const file = path.join(outboxDir, `${Date.now()}-${safeTo}.html`);
    fs.writeFileSync(file, `<!-- To: ${opts.to} / Subject: ${opts.subject} -->\n${opts.html}`);
    console.log(`[mail:dev] Email simulé écrit dans ${file}`);
    return;
  }
  await getTransport().sendMail({
    from: process.env.MAIL_FROM ?? process.env.SMTP_USER,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
  });
}
