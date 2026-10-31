import { contextBridge, ipcRenderer } from 'electron';

/**
 * Seule surface que le renderer voit jamais (cf. plan : `contextIsolation: true`,
 * `nodeIntegration: false` dans `main/index.ts`) — chaque fonction ici est un simple relais vers
 * un `ipcMain.handle(...)` de `main/ipc.ts`. Aucune logique ici, volontairement : un bug dans ce
 * fichier serait un bug dans la frontière de sécurité elle-même.
 */
contextBridge.exposeInMainWorld('smonster', {
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    onMaximizedChanged: (cb: (maximized: boolean) => void) => {
      const handler = (_e: unknown, maximized: boolean) => cb(maximized);
      ipcRenderer.on('window:maximizedChanged', handler);
      return () => ipcRenderer.removeListener('window:maximizedChanged', handler);
    },
  },
  host: {
    platform: () => ipcRenderer.invoke('host:platform'),
    engineForDevice: (device: string) => ipcRenderer.invoke('host:engineForDevice', device),
  },
  auth: {
    restoreSession: () => ipcRenderer.invoke('auth:restoreSession'),
    login: (email: string, password: string) => ipcRenderer.invoke('auth:login', email, password),
    verifyMfa: (challenge: string, code: string) => ipcRenderer.invoke('auth:verifyMfa', challenge, code),
    logout: () => ipcRenderer.invoke('auth:logout'),
    acceptInvite: (token: string, password?: string, displayName?: string) =>
      ipcRenderer.invoke('auth:acceptInvite', token, password, displayName),
  },
  account: {
    get: () => ipcRenderer.invoke('account:get'),
    updateProfile: (displayName: string) => ipcRenderer.invoke('account:updateProfile', displayName),
    changePassword: (currentPassword: string, newPassword: string) =>
      ipcRenderer.invoke('account:changePassword', currentPassword, newPassword),
    totpSetup: () => ipcRenderer.invoke('account:totpSetup'),
    totpEnable: (code: string) => ipcRenderer.invoke('account:totpEnable', code),
    totpDisable: (password: string) => ipcRenderer.invoke('account:totpDisable', password),
    setEmailOtp: (emailOtpEnabled: boolean) => ipcRenderer.invoke('account:setEmailOtp', emailOtpEnabled),
  },
  teams: {
    list: () => ipcRenderer.invoke('teams:list'),
    create: (name: string) => ipcRenderer.invoke('teams:create', name),
    members: (teamId: string) => ipcRenderer.invoke('teams:members', teamId),
    rename: (teamId: string, name: string) => ipcRenderer.invoke('teams:rename', teamId, name),
    delete: (teamId: string) => ipcRenderer.invoke('teams:delete', teamId),
    invite: (teamId: string, email: string, role: string) => ipcRenderer.invoke('teams:invite', teamId, email, role),
    grantPermission: (teamId: string, membershipId: string, permission: string) =>
      ipcRenderer.invoke('teams:grantPermission', teamId, membershipId, permission),
    revokePermission: (teamId: string, membershipId: string, permission: string) =>
      ipcRenderer.invoke('teams:revokePermission', teamId, membershipId, permission),
  },
  proxies: {
    list: (teamId: string) => ipcRenderer.invoke('proxies:list', teamId),
    get: (teamId: string, id: string) => ipcRenderer.invoke('proxies:get', teamId, id),
    create: (teamId: string, input: unknown) => ipcRenderer.invoke('proxies:create', teamId, input),
    update: (teamId: string, id: string, patch: unknown) => ipcRenderer.invoke('proxies:update', teamId, id, patch),
    delete: (teamId: string, id: string) => ipcRenderer.invoke('proxies:delete', teamId, id),
  },
  profiles: {
    list: (teamId: string) => ipcRenderer.invoke('profiles:list', teamId),
    create: (teamId: string, input: unknown) => ipcRenderer.invoke('profiles:create', teamId, input),
    update: (teamId: string, id: string, patch: unknown) => ipcRenderer.invoke('profiles:update', teamId, id, patch),
    delete: (teamId: string, id: string) => ipcRenderer.invoke('profiles:delete', teamId, id),
    launch: (record: unknown) => ipcRenderer.invoke('profiles:launch', record),
    stop: (record: unknown) => ipcRenderer.invoke('profiles:stop', record),
    isRunning: (id: string) => ipcRenderer.invoke('profiles:isRunning', id),
    clearCache: (record: unknown) => ipcRenderer.invoke('profiles:clearCache', record),
    diskInfo: (record: unknown) => ipcRenderer.invoke('profiles:diskInfo', record),
    testProxy: (proxy: unknown) => ipcRenderer.invoke('profiles:testProxy', proxy),
    getExtensions: (profileId: string) => ipcRenderer.invoke('profiles:getExtensions', profileId),
    setExtensions: (profileId: string, extensionPaths: string[]) => ipcRenderer.invoke('profiles:setExtensions', profileId, extensionPaths),
    pickExtensionFolder: () => ipcRenderer.invoke('profiles:pickExtensionFolder'),
  },
  /** Évènements poussés par le serveur (relayés tels quels depuis `main/ipc.ts`, cf. sa liste `ws:*`). */
  events: {
    on: (event: string, cb: (payload: unknown) => void) => {
      const channel = `ws:${event}`;
      const handler = (_e: unknown, payload: unknown) => cb(payload);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },
});
