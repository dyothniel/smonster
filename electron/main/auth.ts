import * as fs from 'fs';
import * as path from 'path';
import { app, safeStorage } from 'electron';
import { CloudClient, CloudApiError } from './cloudClient';
import { getMachineLabel } from './machineId';

export interface AccessTokenClaims {
  sub: string;
  email: string;
  displayName: string;
  isSuperAdmin: boolean;
  teams: { teamId: string; role: 'TEAM_ADMIN' | 'MEMBER' }[];
}

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; displayName: string; isSuperAdmin: boolean };
}

interface MfaChallengeResponse {
  mfa: 'totp' | 'email';
  challenge: string;
}

export type LoginResult =
  | { mfaRequired: false; claims: AccessTokenClaims }
  | { mfaRequired: true; method: 'totp' | 'email'; challenge: string };

function decodeJwtPayload(token: string): AccessTokenClaims {
  // Lecture seule, côté client — la vérification de signature est le travail du SERVEUR à
  // chaque requête ; ici on a juste besoin de lire les claims déjà émis par un serveur en qui
  // on a confiance (on vient de lui parler en HTTPS) pour peupler l'état local de l'UI.
  const payloadB64 = token.split('.')[1];
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as AccessTokenClaims;
}

function refreshTokenFilePath(): string {
  return path.join(app.getPath('userData'), 'refresh-token.enc');
}

/**
 * Cycle de vie de l'authentification côté client lourd (cf. plan : JWT access en mémoire
 * process main SEULEMENT, refresh token persisté via `safeStorage` — DPAPI/libsecret selon
 * l'OS, jamais `keytar`). Le renderer ne voit jamais aucun des deux tokens, uniquement le
 * résultat (`AccessTokenClaims` ou `null`) via l'IPC exposé par `ipc.ts`.
 */
export class AuthManager {
  private accessToken: string | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  readonly cloud: CloudClient;

  constructor(baseUrl: string) {
    this.cloud = new CloudClient(baseUrl, () => this.accessToken);
  }

  getClaims(): AccessTokenClaims | null {
    return this.accessToken ? decodeJwtPayload(this.accessToken) : null;
  }

  /** Pour établir la connexion WebSocket (cf. ipc.ts) — jamais exposé au renderer. */
  getAccessToken(): string | null {
    return this.accessToken;
  }

  private persistRefreshToken(token: string): void {
    const filePath = refreshTokenFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(filePath, safeStorage.encryptString(token));
    } else {
      // Repli best-effort (ex. environnement sans trousseau système disponible) : jamais
      // bloquant pour l'app, mais pas chiffré — log explicite plutôt qu'un échec silencieux.
      console.warn('safeStorage indisponible sur cette machine : refresh token stocké en clair.');
      fs.writeFileSync(filePath, token, 'utf8');
    }
  }

  private readPersistedRefreshToken(): string | null {
    const filePath = refreshTokenFilePath();
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath);
    try {
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
    } catch {
      return null; // fichier corrompu/illisible : traité comme "pas de session persistée"
    }
  }

  private clearPersistedRefreshToken(): void {
    const filePath = refreshTokenFilePath();
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    // Access token valide 15 min côté serveur (cf. jwt.ts) ; on rafraîchit à 12 min pour garder
    // une marge confortable plutôt que de courir après l'expiration exacte.
    this.refreshTimer = setTimeout(() => this.refresh().catch((err) => console.error('Échec du refresh planifié :', err)), 12 * 60 * 1000);
  }

  /** Factorise ce que `login()` et `acceptInvite()` font toutes les deux une fois des tokens en main. */
  private setSession(accessToken: string, refreshToken: string): AccessTokenClaims {
    this.accessToken = accessToken;
    this.persistRefreshToken(refreshToken);
    this.scheduleRefresh();
    return this.getClaims()!;
  }

  /** `mfaRequired: true` si le mot de passe était bon mais qu'un 2e facteur est exigé — pas de
   * session ouverte tant que `verifyMfa()` n'a pas réussi (cf. doc du plan 2FA). */
  async login(email: string, password: string): Promise<LoginResult> {
    const res = await this.cloud.post<LoginResponse | MfaChallengeResponse>(
      '/api/auth/login',
      { email, password, deviceLabel: getMachineLabel() },
      { auth: false }
    );
    if ('mfa' in res) {
      return { mfaRequired: true, method: res.mfa, challenge: res.challenge };
    }
    return { mfaRequired: false, claims: this.setSession(res.accessToken, res.refreshToken) };
  }

  /** Second temps de `login()` quand `mfaRequired` était vrai. */
  async verifyMfa(challenge: string, code: string): Promise<AccessTokenClaims> {
    const res = await this.cloud.post<LoginResponse>(
      '/api/auth/login/verify',
      { challenge, code, deviceLabel: getMachineLabel() },
      { auth: false }
    );
    return this.setSession(res.accessToken, res.refreshToken);
  }

  /**
   * Accepte une invitation (nouveau compte OU compte existant déjà connecté, cf. doc du
   * backend sur `POST /api/auth/accept-invite`) et ouvre directement la session — pas besoin
   * d'un `login()` séparé juste après, le serveur a déjà émis des tokens valides.
   */
  async acceptInvite(token: string, password?: string, displayName?: string): Promise<AccessTokenClaims> {
    const body: Record<string, unknown> = { token };
    if (password) body.password = password;
    if (displayName) body.displayName = displayName;
    const res = await this.cloud.post<LoginResponse>('/api/auth/accept-invite', body, { auth: false });
    return this.setSession(res.accessToken, res.refreshToken);
  }

  /** Au démarrage de l'app : tente de reprendre une session déjà ouverte, sans redemander le mot de passe. */
  async restoreSession(): Promise<AccessTokenClaims | null> {
    const refreshToken = this.readPersistedRefreshToken();
    if (!refreshToken) return null;
    try {
      const res = await this.cloud.post<{ accessToken: string; refreshToken: string }>('/api/auth/refresh', { refreshToken }, { auth: false });
      this.accessToken = res.accessToken;
      this.persistRefreshToken(res.refreshToken);
      this.scheduleRefresh();
      return this.getClaims();
    } catch (err) {
      if (err instanceof CloudApiError && err.status === 401) {
        // Refresh token expiré/révoqué : session définitivement terminée, pas une erreur à
        // remonter bruyamment — juste repartir sur un login normal.
        this.clearPersistedRefreshToken();
        return null;
      }
      throw err;
    }
  }

  private async refresh(): Promise<void> {
    const refreshToken = this.readPersistedRefreshToken();
    if (!refreshToken) return;
    const res = await this.cloud.post<{ accessToken: string; refreshToken: string }>('/api/auth/refresh', { refreshToken }, { auth: false });
    this.accessToken = res.accessToken;
    this.persistRefreshToken(res.refreshToken);
    this.scheduleRefresh();
  }

  async logout(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const refreshToken = this.readPersistedRefreshToken();
    this.accessToken = null;
    this.clearPersistedRefreshToken();
    if (refreshToken) {
      await this.cloud.post('/api/auth/logout', { refreshToken }, { auth: false }).catch(() => {
        // Best-effort : la session locale est déjà effacée, un logout serveur raté ne doit
        // jamais bloquer l'utilisateur hors de l'app.
      });
    }
  }
}
