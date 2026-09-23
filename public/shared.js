// Fonctions partagées entre index.html (grille) et profile.html (settings) : appel API, menu
// contextuel (déclenché à la fois par le bouton "..." et par le clic droit sur une tuile — même
// fonction, deux déclencheurs, cf. openContextMenu ci-dessous), et toasts.

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options && options.headers) },
  });
  let body = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const message = (body && body.error) || `Erreur HTTP ${res.status}`;
    throw new Error(message);
  }
  return body;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
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
 * Menu contextuel générique : une seule instance dans le DOM (#contextMenu), repositionnée et
 * repeuplée à chaque appel. `actions` est une liste de { label, danger?, onClick }.
 * Appelée à la fois par le clic sur le bouton "..." d'une tuile et par `oncontextmenu` (clic
 * droit) sur la tuile elle-même — littéralement le même menu pour les deux déclencheurs.
 */
function openContextMenu(x, y, actions) {
  const menu = document.getElementById('contextMenu');
  menu.innerHTML = '';
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    if (action.danger) btn.classList.add('danger');
    btn.addEventListener('click', () => {
      closeContextMenu();
      action.onClick();
    });
    menu.appendChild(btn);
  }
  // Positionne puis corrige si ça déborde de la fenêtre.
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

// Presets de device curés (parmi la liste complète de playwright.devices côté serveur) : couvre
// desktop, Android (chromium) et iOS/Safari (webkit, cf. resolveEngineForDevice) pour pouvoir
// tester les deux moteurs directement depuis le dashboard.
const DEVICE_PRESETS = [
  'desktop',
  'Desktop Chrome',
  'Desktop Safari',
  'Pixel 7',
  'Pixel 7 Pro',
  'iPhone 15',
  'iPhone 15 Pro Max',
  'iPad Mini',
];

// Locales courantes (format BCP 47 exact attendu par Playwright) — pas de liste standard côté
// navigateur pour ça (contrairement aux fuseaux horaires, cf. TIMEZONE_OPTIONS), donc on en
// curate une plutôt que de laisser un champ texte libre où une faute de frappe (ex. "fr_FR" au
// lieu de "fr-FR") ne serait détectée qu'au lancement.
const LOCALE_PRESETS = [
  'fr-FR',
  'en-US',
  'en-GB',
  'de-DE',
  'es-ES',
  'it-IT',
  'pt-BR',
  'pt-PT',
  'nl-NL',
  'pl-PL',
  'ru-RU',
  'ja-JP',
  'ko-KR',
  'zh-CN',
  'zh-TW',
  'ar-SA',
  'tr-TR',
];

// Liste exhaustive des identifiants IANA valides (~400), générée par le moteur JS du navigateur
// lui-même — aucune liste à maintenir à la main, et toujours d'attaque avec la base tz du
// navigateur. `Intl.supportedValuesOf` est disponible sur tous les navigateurs modernes
// (Chrome/Edge 99+, Firefox 93+, Safari 15.4+) ; filet de sécurité au cas où.
const TIMEZONE_OPTIONS =
  typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : ['Europe/Paris', 'UTC', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'];
