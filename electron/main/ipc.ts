import * as path from 'path';
import { app, dialog, ipcMain, BrowserWindow } from 'electron';
import type { Socket } from 'socket.io-client';
import { detectHostPlatformCategory, resolveEngineForDevice } from '../../app/driverBuilder';
import type { DriverBuilderOptions, ProxyConfig } from '../../app/driverBuilder';
import { AuthManager } from './auth';
import { ElectronProfileManager } from './profileManager';
import type { CloudProfileRecord } from './profileManager';
import { ExtensionsStore } from './extensionsStore';
import { getMachineLabel } from './machineId';
import { minimizeWindow, toggleMaximizeWindow, closeWindow } from './windowControls';

// Prod par défaut (serveur réel sur le VPS, cf. VPS_INFRA.md) pour que quiconque lance l'app
// depuis les sources se connecte directement au bon endroit sans rien configurer — surchargeable
// en dev local via `SMONSTER_CLOUD_URL=http://localhost:3002`.
const CLOUD_BASE_URL = process.env.SMONSTER_CLOUD_URL ?? 'https://smonster.tlposta.com';

/**
 * Surface IPC unique du process main (cf. plan — `preload/index.ts` l'expose au renderer via
 * `contextBridge`, jamais d'accès Node direct depuis le renderer). Regroupe TOUT ici plutôt que
 * d'éclater en plusieurs fichiers `ipc*.ts` : la gestion de la connexion WebSocket (créée après
 * login, détruite à la déconnexion) est un état partagé entre les handlers auth/profils/teams,
 * plus simple à garder cohérent dans un seul scope de closure qu'à faire voyager entre modules.
 */
export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  const auth = new AuthManager(CLOUD_BASE_URL);
  const localProfilesRoot = path.join(app.getPath('userData'), 'browser-profiles');
  // Local à cette machine, indépendant du cycle de vie de la session cloud (survit à un logout/
  // login, contrairement à `profiles` ci-dessous) - cf. doc de `ExtensionsStore`.
  const extensionsStore = new ExtensionsStore(app.getPath('userData'));

  let socket: Socket | null = null;
  let profiles: ElectronProfileManager | null = null;

  function teardownSocket(): void {
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }
    profiles = null;
  }

  function connectSocket(): void {
    teardownSocket();
    const token = auth.getAccessToken();
    if (!token) return;
    const s = auth.cloud.connectSocket(token);
    // Les évènements de présence/catalogue sont du ressort du renderer (mise à jour de l'UI) —
    // le process main se contente de relayer, aucune logique métier ici.
    for (const event of [
      'presence:acquired',
      'presence:released',
      'profile:created',
      'profile:updated',
      'profile:deleted',
      'proxy:created',
      'proxy:updated',
      'proxy:deleted',
      'member:joined',
      'member:updated',
      'member:removed',
      'permissions:updated',
    ]) {
      s.on(event, (payload: unknown) => mainWindow.webContents.send(`ws:${event}`, payload));
    }
    socket = s;
    profiles = new ElectronProfileManager(localProfilesRoot, auth.cloud, s);
  }

  // --- Fenêtre ---------------------------------------------------------------------------
  ipcMain.handle('window:minimize', () => minimizeWindow(mainWindow));
  ipcMain.handle('window:toggleMaximize', () => toggleMaximizeWindow(mainWindow));
  ipcMain.handle('window:close', () => closeWindow(mainWindow));

  // --- Hôte --------------------------------------------------------------------------------
  // Remplace l'ancien `GET /api/host-info` (cf. plan) : c'est intrinsèquement une question sur
  // CETTE machine (celle qui va lancer Chrome), pas une question pour le cloud.
  ipcMain.handle('host:platform', () => detectHostPlatformCategory());
  // Pour savoir si la section "Extensions" a un sens pour le device actuellement choisi dans le
  // formulaire (Chromium seulement, cf. doc de `DriverBuilderOptions.extensionPaths`) - un seul
  // point de vérité (`resolveEngineForDevice`), jamais dupliqué côté renderer.
  ipcMain.handle('host:engineForDevice', (_e, device: string) => resolveEngineForDevice(device as NonNullable<DriverBuilderOptions['device']>));

  // --- Auth --------------------------------------------------------------------------------
  ipcMain.handle('auth:restoreSession', async () => {
    const claims = await auth.restoreSession();
    if (claims) connectSocket();
    return claims;
  });
  ipcMain.handle('auth:login', async (_e, email: string, password: string) => {
    const result = await auth.login(email, password);
    if (!result.mfaRequired) connectSocket(); // sinon : pas encore de session, cf. auth:verifyMfa
    return result;
  });
  ipcMain.handle('auth:verifyMfa', async (_e, challenge: string, code: string) => {
    const claims = await auth.verifyMfa(challenge, code);
    connectSocket();
    return claims;
  });
  ipcMain.handle('auth:logout', async () => {
    teardownSocket();
    await auth.logout();
  });
  ipcMain.handle('auth:acceptInvite', async (_e, token: string, password?: string, displayName?: string) => {
    const claims = await auth.acceptInvite(token, password, displayName);
    connectSocket();
    return claims;
  });

  // --- Mon compte (profil, mot de passe, 2FA) -----------------------------------------------
  ipcMain.handle('account:get', () => auth.cloud.get('/api/account'));
  ipcMain.handle('account:updateProfile', (_e, displayName: string) => auth.cloud.patch('/api/account', { displayName }));
  ipcMain.handle('account:changePassword', (_e, currentPassword: string, newPassword: string) =>
    auth.cloud.post('/api/account/password', { currentPassword, newPassword })
  );
  ipcMain.handle('account:totpSetup', () => auth.cloud.post('/api/account/totp/setup'));
  ipcMain.handle('account:totpEnable', (_e, code: string) => auth.cloud.post('/api/account/totp/enable', { code }));
  ipcMain.handle('account:totpDisable', (_e, password: string) => auth.cloud.post('/api/account/totp/disable', { password }));
  ipcMain.handle('account:setEmailOtp', (_e, emailOtpEnabled: boolean) => auth.cloud.patch('/api/account/security', { emailOtpEnabled }));

  // --- Teams -------------------------------------------------------------------------------
  ipcMain.handle('teams:list', () => auth.cloud.get('/api/teams'));
  ipcMain.handle('teams:create', (_e, name: string) => auth.cloud.post('/api/teams', { name }));
  ipcMain.handle('teams:members', (_e, teamId: string) => auth.cloud.get(`/api/teams/${teamId}/members`));
  ipcMain.handle('teams:rename', (_e, teamId: string, name: string) => auth.cloud.patch(`/api/teams/${teamId}`, { name }));
  ipcMain.handle('teams:delete', (_e, teamId: string) => auth.cloud.delete(`/api/teams/${teamId}`));
  ipcMain.handle('teams:invite', (_e, teamId: string, email: string, role: string) =>
    auth.cloud.post(`/api/teams/${teamId}/invites`, { email, role })
  );
  ipcMain.handle('teams:grantPermission', (_e, teamId: string, membershipId: string, permission: string) =>
    auth.cloud.put(`/api/teams/${teamId}/members/${membershipId}/permissions/${permission}`)
  );
  ipcMain.handle('teams:revokePermission', (_e, teamId: string, membershipId: string, permission: string) =>
    auth.cloud.delete(`/api/teams/${teamId}/members/${membershipId}/permissions/${permission}`)
  );

  // --- Proxies -------------------------------------------------------------------------------
  ipcMain.handle('proxies:list', (_e, teamId: string) => auth.cloud.get(`/api/teams/${teamId}/proxies`));
  ipcMain.handle('proxies:get', (_e, teamId: string, id: string) => auth.cloud.get(`/api/teams/${teamId}/proxies/${id}`));
  ipcMain.handle('proxies:create', (_e, teamId: string, input: unknown) => auth.cloud.post(`/api/teams/${teamId}/proxies`, input));
  ipcMain.handle('proxies:update', (_e, teamId: string, id: string, patch: unknown) => auth.cloud.patch(`/api/teams/${teamId}/proxies/${id}`, patch));
  ipcMain.handle('proxies:delete', (_e, teamId: string, id: string) => auth.cloud.delete(`/api/teams/${teamId}/proxies/${id}`));

  // --- Profils (catalogue) -------------------------------------------------------------------
  ipcMain.handle('profiles:list', (_e, teamId: string) => auth.cloud.get(`/api/teams/${teamId}/profiles`));
  ipcMain.handle('profiles:create', (_e, teamId: string, input: unknown) => auth.cloud.post(`/api/teams/${teamId}/profiles`, input));
  ipcMain.handle('profiles:update', (_e, teamId: string, id: string, patch: unknown) => auth.cloud.patch(`/api/teams/${teamId}/profiles/${id}`, patch));
  ipcMain.handle('profiles:delete', (_e, teamId: string, id: string) => auth.cloud.delete(`/api/teams/${teamId}/profiles/${id}`));

  // --- Lancement local (cf. profileManager.ts) ------------------------------------------------
  ipcMain.handle('profiles:launch', async (_e, record: CloudProfileRecord) => {
    if (!profiles) throw new Error('Non connecté.');
    // Résolu ICI (pas envoyé par le renderer) : `extensionsStore` est la seule source de vérité
    // pour ce qui est réellement configuré SUR CETTE machine, indépendamment de ce que le
    // renderer avait en cache au moment de construire `record`.
    await profiles.launch({ ...record, extensionPaths: extensionsStore.get(record.id) }, getMachineLabel());
    return { ok: true };
  });
  ipcMain.handle('profiles:stop', async (_e, record: CloudProfileRecord) => {
    if (!profiles) throw new Error('Non connecté.');
    await profiles.stop(record);
    return { ok: true };
  });
  ipcMain.handle('profiles:isRunning', (_e, id: string) => !!profiles?.isRunning(id));
  ipcMain.handle('profiles:clearCache', async (_e, record: CloudProfileRecord) => {
    if (!profiles) throw new Error('Non connecté.');
    await profiles.clearCache(record);
    return { ok: true };
  });
  ipcMain.handle('profiles:diskInfo', async (_e, record: CloudProfileRecord) => {
    if (!profiles) throw new Error('Non connecté.');
    return profiles.getDiskInfo(record);
  });
  ipcMain.handle('profiles:testProxy', async (_e, proxy: ProxyConfig) => {
    if (!profiles) throw new Error('Non connecté.');
    return profiles.testProxy(proxy);
  });

  // --- Extensions (locales à cette machine, cf. ExtensionsStore) -----------------------------
  ipcMain.handle('profiles:getExtensions', (_e, profileId: string) => extensionsStore.get(profileId));
  ipcMain.handle('profiles:setExtensions', (_e, profileId: string, extensionPaths: string[]) => {
    extensionsStore.set(profileId, extensionPaths);
    return { ok: true };
  });
  ipcMain.handle('profiles:pickExtensionFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: "Choisir le dossier de l'extension (non empaquetée)",
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // Ferme proprement les profils encore actifs SUR CETTE MACHINE avant de quitter : empaquette/
  // uploade leur état et libère leur verrou cloud (cf. `ElectronProfileManager.stopAll()`), pour
  // qu'un autre membre de la team puisse les reprendre immédiatement après plutôt que d'attendre
  // le délai du heartbeat de présence. Best-effort borné dans le temps : ne bloque jamais la
  // fermeture de l'app indéfiniment si le réseau est coupé.
  app.on('before-quit', (event) => {
    if (!profiles) return;
    const manager = profiles;
    event.preventDefault();
    Promise.race([manager.stopAll(), new Promise((resolve) => setTimeout(resolve, 5000))]).finally(() => app.exit());
  });
}
