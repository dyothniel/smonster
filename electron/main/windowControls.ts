import type { BrowserWindow } from 'electron';

/**
 * `frame: false` retire le chrome natif sur TOUTES les plateformes (cf. plan : Electron ne
 * dessine de vrais feux macOS que sur un vrai Mac) — ces trois actions remplacent entièrement
 * les boutons natifs minimize/maximize/close, appelées depuis le renderer via l'IPC exposé par
 * `ipc.ts`/`preload/index.ts`. L'état "maximisé" est poussé vers le renderer (pas interrogé à la
 * demande) pour que l'icône du bouton puisse refléter l'état réel même quand il change par un
 * autre biais que ce bouton (double-clic sur la barre de titre, raccourci OS, redimensionnement
 * manuel jusqu'au bord de l'écran...).
 */
export function registerWindowControls(win: BrowserWindow, onMaximizedChange: (maximized: boolean) => void): void {
  win.on('maximize', () => onMaximizedChange(true));
  win.on('unmaximize', () => onMaximizedChange(false));
}

export function minimizeWindow(win: BrowserWindow): void {
  win.minimize();
}

export function toggleMaximizeWindow(win: BrowserWindow): void {
  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
}

export function closeWindow(win: BrowserWindow): void {
  win.close();
}
