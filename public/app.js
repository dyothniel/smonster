// Dashboard principal : grille de profils, sélection multiple, actions groupées, menu
// contextuel par tuile (bouton "..." et clic droit ouvrent le même menu, cf. shared.js).

let profiles = [];
const selected = new Set();
let proxyTarget = null; // { ids: string[] } — cible courante de la modale de config proxy

async function refresh() {
  try {
    profiles = await api('/api/profiles');
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  // Retire de la sélection les profils supprimés entre deux polls.
  const ids = new Set(profiles.map((p) => p.id));
  for (const id of [...selected]) {
    if (!ids.has(id)) selected.delete(id);
  }
  updateToolbar();
  renderGrid();
}

function renderGrid() {
  const grid = document.getElementById('profileGrid');
  if (profiles.length === 0) {
    grid.innerHTML = '<div class="empty-state">Aucun profil pour l\'instant — crée-en un.</div>';
    return;
  }
  grid.innerHTML = '';
  for (const p of profiles) {
    grid.appendChild(renderTile(p));
  }
}

function healthInfo(p) {
  if (p.running) {
    return p.connected ? { dot: 'green', label: 'connecté' } : { dot: 'red', label: 'déconnecté' };
  }
  if (p.lastLaunchResult) {
    return p.lastLaunchResult.ok
      ? { dot: 'yellow', label: 'dernier lancement OK' }
      : { dot: 'red', label: 'dernier lancement en échec' };
  }
  return { dot: '', label: 'jamais lancé' };
}

function renderTile(p) {
  const tile = document.createElement('div');
  tile.className = 'tile' + (selected.has(p.id) ? ' selected' : '');
  tile.dataset.id = p.id;

  const health = healthInfo(p);

  tile.innerHTML = `
    <div class="tile-top">
      <div class="tile-select">
        <span class="tile-select-checkbox"></span>
        <span class="tile-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
      </div>
      <button class="tile-menu-btn" title="Actions">&#8942;</button>
    </div>
    <div class="tile-meta">
      <span class="badge"><span class="dot ${p.running ? 'green' : ''}"></span>${p.running ? 'actif' : 'arrêté'}</span>
      <span class="badge"><span class="dot ${health.dot}"></span>${health.label}</span>
      <span class="badge">${escapeHtml(p.device)}</span>
      ${p.proxy ? '<span class="badge">proxy</span>' : ''}
    </div>
    <div class="tile-actions">
      <button class="tile-toggle">${p.running ? 'Stopper' : 'Lancer'}</button>
      <button class="tile-settings">Réglages</button>
    </div>
  `;

  const checkbox = createCheckbox({
    checked: selected.has(p.id),
    variant: 'checkbox',
    title: 'Sélectionner ce profil',
    onChange: (checked) => toggleSelect(tile, p.id, checked),
  });
  tile.querySelector('.tile-select-checkbox').replaceWith(checkbox);

  tile.querySelector('.tile-toggle').addEventListener('click', () => {
    doAction(() => api(`/api/profiles/${p.id}/${p.running ? 'stop' : 'launch'}`, { method: 'POST' }));
  });
  tile.querySelector('.tile-settings').addEventListener('click', () => {
    location.href = `profile.html?id=${encodeURIComponent(p.id)}`;
  });
  tile.querySelector('.tile-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    openContextMenu(rect.left, rect.bottom + 4, singleProfileActions(p));
  });
  tile.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, singleProfileActions(p));
  });

  return tile;
}

function singleProfileActions(p) {
  return [
    {
      label: p.running ? 'Stopper' : 'Lancer',
      onClick: () => doAction(() => api(`/api/profiles/${p.id}/${p.running ? 'stop' : 'launch'}`, { method: 'POST' })),
    },
    {
      label: 'Vider le cache',
      onClick: () =>
        confirmThen(`Vider le cache de "${p.name}" ?`, () =>
          doAction(() => api(`/api/profiles/${p.id}/clear-cache`, { method: 'POST' }))
        ),
    },
    { label: 'Config proxy', onClick: () => openProxyModal({ ids: [p.id] }, p.proxy) },
    { label: 'Réglages', onClick: () => (location.href = `profile.html?id=${encodeURIComponent(p.id)}`) },
    {
      label: 'Supprimer',
      danger: true,
      onClick: () =>
        confirmThen(`Supprimer définitivement "${p.name}" ?`, () =>
          doAction(() => api(`/api/profiles/${p.id}`, { method: 'DELETE' }))
        ),
    },
  ];
}

function toggleSelect(tile, id, checked) {
  if (checked) selected.add(id);
  else selected.delete(id);
  tile.classList.toggle('selected', checked);
  updateToolbar();
}

function updateToolbar() {
  const toolbar = document.getElementById('bulkToolbar');
  toolbar.classList.toggle('visible', selected.size > 0);
  document.getElementById('bulkCount').textContent = `${selected.size} sélectionné(s)`;
}

async function doAction(fn) {
  try {
    await fn();
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function confirmThen(message, fn) {
  if (confirm(message)) fn();
}

// --- Actions groupées (toolbar) ---------------------------------------------------------

async function runBulk(action, extra) {
  const ids = [...selected];
  if (ids.length === 0) return;
  try {
    const results = await api('/api/profiles/bulk', {
      method: 'POST',
      body: JSON.stringify({ ids, action, ...extra }),
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) {
      toast(`${results.length} profil(s) : action "${action}" OK.`);
    } else {
      toast(`${results.length - failed.length} OK, ${failed.length} en échec (${failed[0].error}).`, 'error');
    }
    selected.clear();
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('bulkLaunch').addEventListener('click', () => runBulk('launch'));
document.getElementById('bulkStop').addEventListener('click', () => runBulk('stop'));
document.getElementById('bulkClearCache').addEventListener('click', () => {
  confirmThen(`Vider le cache de ${selected.size} profil(s) ?`, () => runBulk('clear-cache'));
});
document.getElementById('bulkDelete').addEventListener('click', () => {
  confirmThen(`Supprimer définitivement ${selected.size} profil(s) ?`, () => runBulk('delete'));
});
document.getElementById('bulkSetProxy').addEventListener('click', () => {
  openProxyModal({ ids: [...selected] }, null);
});
document.getElementById('bulkClearSelection').addEventListener('click', () => {
  selected.clear();
  updateToolbar();
  renderGrid();
});

// --- Modale : config proxy (bulk ou profil unique, même modale) -------------------------

function openProxyModal(target, currentProxy) {
  proxyTarget = target;
  document.getElementById('proxyModalTarget').textContent =
    target.ids.length === 1 ? '1 profil ciblé' : `${target.ids.length} profils ciblés`;
  document.getElementById('pxServer').value = (currentProxy && currentProxy.server) || '';
  document.getElementById('pxUser').value = (currentProxy && currentProxy.username) || '';
  document.getElementById('pxPass').value = (currentProxy && currentProxy.password) || '';
  document.getElementById('pxRotation').value = (currentProxy && currentProxy.rotationUrl) || '';
  document.getElementById('proxyModal').classList.add('visible');
}
function closeProxyModal() {
  document.getElementById('proxyModal').classList.remove('visible');
  proxyTarget = null;
}
document.getElementById('pxCancel').addEventListener('click', closeProxyModal);
document.getElementById('proxyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const server = document.getElementById('pxServer').value.trim();
  const proxy = server
    ? {
        server,
        username: document.getElementById('pxUser').value.trim() || undefined,
        password: document.getElementById('pxPass').value.trim() || undefined,
        rotationUrl: document.getElementById('pxRotation').value.trim() || undefined,
      }
    : null;
  try {
    await api('/api/profiles/bulk', {
      method: 'POST',
      body: JSON.stringify({ ids: proxyTarget.ids, action: 'set-proxy', proxy }),
    });
    toast('Proxy mis à jour.');
    closeProxyModal();
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// --- Modale : nouveau profil -------------------------------------------------------------

const npHeadlessWidget = createCheckbox({ checked: true, variant: 'switch', title: 'Lancer sans interface graphique' });
document.getElementById('npHeadlessContainer').appendChild(npHeadlessWidget);

const npDeviceWidget = createSelect({ options: DEVICE_PRESETS, value: 'desktop' });
document.getElementById('npDeviceContainer').appendChild(npDeviceWidget);

const npLocaleWidget = createSelect({ options: LOCALE_PRESETS, value: 'fr-FR' });
document.getElementById('npLocaleContainer').appendChild(npLocaleWidget);

const npTzWidget = createSelect({ options: TIMEZONE_OPTIONS, value: 'Europe/Paris' });
document.getElementById('npTzContainer').appendChild(npTzWidget);

document.getElementById('newProfileBtn').addEventListener('click', () => {
  document.getElementById('newProfileForm').reset();
  npHeadlessWidget.checked = true;
  npDeviceWidget.value = 'desktop';
  npLocaleWidget.value = 'fr-FR';
  npTzWidget.value = 'Europe/Paris';
  document.getElementById('newProfileModal').classList.add('visible');
});
document.getElementById('npCancel').addEventListener('click', () => {
  document.getElementById('newProfileModal').classList.remove('visible');
});
document.getElementById('newProfileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('npName').value.trim();
  if (!name) return;

  const payload = {
    name,
    headless: npHeadlessWidget.checked,
    device: npDeviceWidget.value,
    locale: npLocaleWidget.value,
    timezoneId: npTzWidget.value,
  };
  const proxyServer = document.getElementById('npProxyServer').value.trim();
  if (proxyServer) {
    payload.proxy = {
      server: proxyServer,
      username: document.getElementById('npProxyUser').value.trim() || undefined,
      password: document.getElementById('npProxyPass').value.trim() || undefined,
      rotationUrl: document.getElementById('npProxyRotation').value.trim() || undefined,
    };
  }

  try {
    await api('/api/profiles', { method: 'POST', body: JSON.stringify(payload) });
    toast('Profil créé.');
    document.getElementById('newProfileModal').classList.remove('visible');
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
});

refresh();
setInterval(refresh, 4000);
