import * as path from 'path';
import { app, BrowserWindow } from 'electron';
import { registerWindowControls } from './windowControls';
import { registerIpcHandlers } from './ipc';

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    // Retire le chrome natif sur TOUTES les plateformes (cf. plan et doc de windowControls.ts) :
    // la barre de titre avec les 3 ronds colorés façon macOS est entièrement dessinée par
    // `electron/renderer/`, pilotée via IPC.
    frame: false,
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (!app.isPackaged) {
    // Diagnostic dev uniquement : relaie la console du renderer (erreurs JS incluses) vers le
    // stdout du process main, seul flux qu'on peut inspecter facilement hors DevTools.
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
  }

  registerWindowControls(win, (maximized) => {
    win.webContents.send('window:maximizedChanged', maximized);
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

app.whenReady().then(() => {
  mainWindow = createMainWindow();
  registerIpcHandlers(mainWindow);

  app.on('activate', () => {
    // Convention macOS standard : ré-ouvrir une fenêtre si l'app est ré-activée sans fenêtre
    // ouverte (ex. depuis le dock). Sans incidence sur Linux/Windows (cette branche n'y est
    // jamais empruntée, `window-all-closed` ferme déjà l'app sur ces plateformes, cf. ci-dessous).
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Convention standard : sur macOS une app reste active sans fenêtre (dock), partout ailleurs
  // (Linux/Windows, les deux plateformes réellement ciblées ici) elle quitte.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
