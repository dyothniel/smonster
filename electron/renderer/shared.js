// Utilitaires partagés — adaptés de public/shared.js (cf. plan §UI, migration quasi telle
// quelle) : `api()` est remplacé entièrement, le renderer ne parle JAMAIS en réseau directement,
// tout passe par `window.smonster.*` (IPC vers le process main, cf. preload/index.ts).

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function formatBytes(bytes) {
  if (!bytes) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function toast(message, type) {
  const container = document.getElementById('toasts');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/**
 * Désactive un bouton + affiche un spinner pendant une action async, restaure son état après
 * (même en cas d'erreur — `finally`). Sans ça, un clic sur un bouton à requête réseau/IPC ne
 * donnait AUCUN retour visuel avant que la modale ne s'ouvre ou que la liste ne se re-rende :
 * l'app avait l'air figée/buguée le temps du aller-retour (ex. "Activer" la 2FA par application,
 * qui attend `/totp/setup` avant d'ouvrir sa modale).
 */
async function withBusy(button, fn) {
  if (!button) return fn();
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.classList.add('is-busy');
  try {
    return await fn();
  } finally {
    button.disabled = wasDisabled;
    button.classList.remove('is-busy');
  }
}

function openContextMenu(x, y, actions) {
  const menu = document.getElementById('contextMenu');
  menu.innerHTML = '';
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    if (action.danger) btn.classList.add('danger');
    if (action.disabled) btn.disabled = true;
    btn.addEventListener('click', () => {
      closeContextMenu();
      action.onClick();
    });
    menu.appendChild(btn);
  }
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.classList.add('visible');
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
  }
}

function closeContextMenu() {
  const menu = document.getElementById('contextMenu');
  if (menu) menu.classList.remove('visible');
}

document.addEventListener('click', (e) => {
  const menu = document.getElementById('contextMenu');
  if (menu && !menu.contains(e.target)) closeContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeContextMenu();
});

// Mêmes presets que l'ancien dashboard (cf. public/shared.js) — toujours d'actualité, aucun
// changement d'architecture ne les affecte.
const DEVICE_PRESETS = ['desktop', 'Desktop Safari', 'Pixel 7', 'Pixel 7 Pro', 'iPhone 15', 'iPhone 15 Pro Max', 'iPad Mini'];
const LOCALE_PRESETS = [
  'fr-FR', 'en-US', 'en-GB', 'de-DE', 'es-ES', 'it-IT', 'pt-BR', 'pt-PT', 'nl-NL', 'pl-PL',
  'ru-RU', 'ja-JP', 'ko-KR', 'zh-CN', 'zh-TW', 'ar-SA', 'tr-TR',
];
const TIMEZONE_OPTIONS =
  typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : ['Europe/Paris', 'UTC', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'];

const DESKTOP_PLATFORM_LABELS = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
let desktopPlatformLabel = null;
const desktopPlatformReady = window.smonster.host
  .platform()
  .then((platform) => {
    desktopPlatformLabel = DESKTOP_PLATFORM_LABELS[platform] || platform;
  })
  .catch(() => {
    // Best-effort : l'indicateur est un confort, jamais bloquant pour créer/éditer un profil.
  });

/** Met à jour le petit texte sous le sélecteur de device avec le système que 'desktop' va claim. */
function updateDevicePlatformHint(device, hintElementId) {
  const hint = document.getElementById(hintElementId);
  if (!hint) return;
  hint.textContent =
    device === 'desktop' && desktopPlatformLabel ? `→ ce profil va claim : ${desktopPlatformLabel} (système hôte détecté)` : '';
  if (device === 'desktop' && !desktopPlatformLabel) {
    desktopPlatformReady.then(() => updateDevicePlatformHint(device, hintElementId));
  }
}
