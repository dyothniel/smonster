// Barre de titre custom (cf. plan §Architecture Electron) : `frame: false` retire tout chrome
// natif, ces trois ronds colorés + le comportement de la barre (drag, double-clic pour
// maximiser) sont entièrement recréés ici, pilotés via `window.smonster.window.*` (IPC).
function initTitlebar() {
  const minimizeBtn = document.getElementById('titlebarMinimize');
  const maximizeBtn = document.getElementById('titlebarMaximize');
  const closeBtn = document.getElementById('titlebarClose');
  const dragRegion = document.getElementById('titlebarDrag');

  minimizeBtn.addEventListener('click', () => window.smonster.window.minimize());
  maximizeBtn.addEventListener('click', () => window.smonster.window.toggleMaximize());
  closeBtn.addEventListener('click', () => window.smonster.window.close());
  dragRegion.addEventListener('dblclick', () => window.smonster.window.toggleMaximize());

  window.smonster.window.onMaximizedChanged((maximized) => {
    document.body.classList.toggle('window-maximized', maximized);
  });
}
