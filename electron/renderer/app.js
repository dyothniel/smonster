// Logique principale du renderer — adaptée de public/app.js (cf. plan §UI), mais branchée sur
// `window.smonster.*` (IPC vers le cloud via le process main) au lieu d'un `fetch()` direct, et
// pilotée par des push WebSocket (`window.smonster.events.on(...)`) plutôt qu'un polling.

// Mêmes tracés que la sidebar/login (cf. index.html) - répétés ici en constantes JS plutôt que
// dupliqués à chaque appel de rendu, pour garder un seul vocabulaire d'icônes dans toute l'app.
const ICON_BROWSER =
  '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" stroke-width="1.6"/><path d="M3 9h18" stroke="currentColor" stroke-width="1.6"/><circle cx="6.5" cy="7" r="0.6" fill="currentColor"/><circle cx="8.5" cy="7" r="0.6" fill="currentColor"/></svg>';
const ICON_GLOBE =
  '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.6"/><ellipse cx="12" cy="12" rx="3.6" ry="8.5" stroke="currentColor" stroke-width="1.4"/><path d="M3.5 12h17" stroke="currentColor" stroke-width="1.4"/></svg>';
const ICON_MOBILE =
  '<svg viewBox="0 0 24 24" fill="none"><rect x="6.5" y="2.5" width="11" height="19" rx="2.3" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 18.5h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICON_TEAM =
  '<svg viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8.5" r="2.6" stroke="currentColor" stroke-width="1.6"/><path d="M4 18c0-2.9 2.3-5 5-5s5 2.1 5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="16.5" cy="9.5" r="2.1" stroke="currentColor" stroke-width="1.6"/><path d="M14.8 13.2c2.3.2 4.2 2 4.2 4.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICON_CHEVRONS_UPDOWN =
  '<svg viewBox="0 0 16 16" fill="none"><path d="M4.5 6.5L8 3l3.5 3.5M4.5 9.5L8 13l3.5-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TEAM_ROLE_LABEL = { TEAM_ADMIN: 'Admin', MEMBER: 'Membre' };

const authStore = createStore({ claims: null });
const teamStore = createStore({ teams: [], currentTeamId: null });
const profilesStore = createStore({ items: [], loading: false });
const proxiesStore = createStore({ items: [] });
const membersStore = createStore({ items: [] });

function currentTeam() {
  const { teams, currentTeamId } = teamStore.get();
  return teams.find((t) => t.team.id === currentTeamId) || null;
}
function currentRole() {
  const claims = authStore.get().claims;
  if (claims?.isSuperAdmin) return 'SUPER_ADMIN';
  return currentTeam()?.role ?? null;
}
function canManageTeam() {
  return currentRole() === 'TEAM_ADMIN' || currentRole() === 'SUPER_ADMIN';
}

// --- Chargement des données de la team active -----------------------------------------------

async function loadProfiles() {
  const teamId = teamStore.get().currentTeamId;
  if (!teamId) return;
  profilesStore.set({ loading: true });
  try {
    const items = await window.smonster.profiles.list(teamId);
    profilesStore.set({ items, loading: false });
  } catch (err) {
    profilesStore.set({ loading: false });
    toast(err.message, 'error');
  }
}

async function loadProxies() {
  const teamId = teamStore.get().currentTeamId;
  if (!teamId) return;
  try {
    proxiesStore.set({ items: await window.smonster.proxies.list(teamId) });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadMembers() {
  const teamId = teamStore.get().currentTeamId;
  if (!teamId || !canManageTeam()) return;
  try {
    membersStore.set({ items: await window.smonster.teams.members(teamId) });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function switchTeam(teamId) {
  teamStore.set({ currentTeamId: teamId });
  await Promise.all([loadProfiles(), loadProxies(), loadMembers()]);
}

// --- Évènements temps réel (poussés par le serveur, relayés par le process main) -------------

function patchItem(items, id, patch) {
  return items.map((it) => (it.id === id ? { ...it, ...patch } : it));
}

window.smonster.events.on('profile:created', (p) => {
  if (p.teamId === teamStore.get().currentTeamId) profilesStore.set((s) => ({ ...s, items: [...s.items, p] }));
});
window.smonster.events.on('profile:updated', (p) => {
  profilesStore.set((s) => ({ ...s, items: patchItem(s.items, p.id, p) }));
});
window.smonster.events.on('profile:deleted', ({ id }) => {
  profilesStore.set((s) => ({ ...s, items: s.items.filter((it) => it.id !== id) }));
});
window.smonster.events.on('proxy:created', (p) => {
  if (p.teamId === teamStore.get().currentTeamId) proxiesStore.set((s) => ({ ...s, items: [...s.items, p] }));
});
window.smonster.events.on('proxy:updated', (p) => {
  proxiesStore.set((s) => ({ ...s, items: patchItem(s.items, p.id, p) }));
});
window.smonster.events.on('proxy:deleted', ({ id }) => {
  proxiesStore.set((s) => ({ ...s, items: s.items.filter((it) => it.id !== id) }));
});
window.smonster.events.on('presence:acquired', ({ profileId, userId, displayName, machineLabel }) => {
  profilesStore.set((s) => ({ ...s, items: patchItem(s.items, profileId, { inUseBy: { userId, displayName, machineLabel } }) }));
});
window.smonster.events.on('presence:released', ({ profileId }) => {
  profilesStore.set((s) => ({ ...s, items: patchItem(s.items, profileId, { inUseBy: null }) }));
});
window.smonster.events.on('member:joined', loadMembers);
window.smonster.events.on('member:updated', loadMembers);
window.smonster.events.on('member:removed', loadMembers);
window.smonster.events.on('permissions:updated', loadMembers);

// --- Rendu : grille de profils -----------------------------------------------------------------

function statusBadge(profile, isRunningHere) {
  if (isRunningHere) return { label: 'En cours (cette machine)', dot: 'green' };
  if (profile.inUseBy) return { label: `En cours — ${profile.inUseBy.machineLabel || profile.inUseBy.displayName || 'ailleurs'}`, dot: 'yellow' };
  return { label: 'Disponible', dot: '' };
}

async function renderProfileGrid() {
  const grid = document.getElementById('profileGrid');
  const { items, loading } = profilesStore.get();
  if (loading && items.length === 0) {
    grid.innerHTML = '<div class="empty-state">Chargement…</div>';
    return;
  }
  if (items.length === 0) {
    grid.innerHTML = `
      <div class="empty-state empty-illustrated">
        <div class="empty-icon empty-icon-browser">${ICON_BROWSER}</div>
        <h3>Aucun profil pour l'instant</h3>
        <p>Un profil garde sa propre empreinte (device, locale, fuseau) et sa session — cookies inclus, synchronisée entre tous les membres de l'équipe.</p>
        <button type="button" class="primary empty-cta">+ Nouveau profil</button>
      </div>`;
    grid.querySelector('.empty-cta').addEventListener('click', () => openProfileModal(null));
    return;
  }

  const runningFlags = await Promise.all(items.map((p) => window.smonster.profiles.isRunning(p.id)));

  grid.innerHTML = '';
  items.forEach((profile, i) => {
    const isRunningHere = runningFlags[i];
    const status = statusBadge(profile, isRunningHere);
    const canLaunch = !profile.inUseBy || isRunningHere;

    const isMobileDevice = /pixel|iphone|ipad/i.test(profile.device);
    const proxyName = profile.proxyId ? proxiesStore.get().items.find((p) => p.id === profile.proxyId)?.label : null;

    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.innerHTML = `
      <div class="tile-top">
        <div class="tile-icon">${isMobileDevice ? ICON_MOBILE : ICON_BROWSER}</div>
        <div class="tile-name">${escapeHtml(profile.name)}</div>
        <button class="tile-menu-btn" type="button">⋯</button>
      </div>
      <div class="tile-meta">
        <span class="badge">${escapeHtml(profile.device)}</span>
        <span class="badge"><span class="dot ${status.dot}"></span>${escapeHtml(status.label)}</span>
        ${proxyName ? `<span class="badge" title="Proxy">${ICON_GLOBE}${escapeHtml(proxyName)}</span>` : ''}
      </div>
      <div class="tile-actions">
        <button type="button" class="tile-action-launch" ${canLaunch ? '' : 'disabled'}>${isRunningHere ? 'Arrêter' : 'Lancer'}</button>
      </div>
    `;

    tile.querySelector('.tile-action-launch').addEventListener('click', async (e) => {
      try {
        await withBusy(e.currentTarget, async () => {
          const record = await toCloudRecord(profile);
          if (isRunningHere) {
            await window.smonster.profiles.stop(record);
            toast(`${profile.name} arrêté.`);
          } else {
            await window.smonster.profiles.launch(record);
            toast(`${profile.name} lancé.`);
          }
        });
      } catch (err) {
        toast(err.message, 'error');
      }
      renderProfileGrid();
    });

    tile.querySelector('.tile-menu-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const rect = e.target.getBoundingClientRect();
      openContextMenu(rect.left, rect.bottom + 4, [
        { label: 'Modifier', onClick: () => openProfileModal(profile) },
        {
          label: 'Vider le cache',
          disabled: !canLaunch,
          onClick: async () => {
            try {
              const record = await toCloudRecord(profile);
              await window.smonster.profiles.clearCache(record);
              toast(`Cache de ${profile.name} vidé.`);
            } catch (err) {
              toast(err.message, 'error');
            }
            renderProfileGrid();
          },
        },
        {
          label: 'Supprimer',
          danger: true,
          onClick: async () => {
            try {
              await window.smonster.profiles.delete(teamStore.get().currentTeamId, profile.id);
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
      ]);
    });

    grid.appendChild(tile);
  });
}

/**
 * La liste de proxys en cache (`proxiesStore`) ne contient jamais le mot de passe (cf.
 * proxiesRouter.ts : seul un GET d'un proxy précis le renvoie déchiffré) — il faut donc
 * aller le rechercher explicitement avant de lancer, plutôt que de lire le cache.
 */
async function toCloudRecord(profile) {
  let proxy = null;
  if (profile.proxyId) {
    proxy = await window.smonster.proxies.get(profile.teamId, profile.proxyId);
  }
  return {
    id: profile.id,
    teamId: profile.teamId,
    name: profile.name,
    device: profile.device,
    locale: profile.locale,
    timezoneId: profile.timezoneId,
    headlessDefault: profile.headlessDefault,
    proxy: proxy ? { server: proxy.server, username: proxy.username || undefined, password: proxy.password || undefined, bypass: proxy.bypass || undefined } : null,
  };
}

profilesStore.subscribe(renderProfileGrid);

// --- Rendu : proxys --------------------------------------------------------------------------

function renderProxyList() {
  const container = document.getElementById('proxyList');
  const items = proxiesStore.get().items;
  if (items.length === 0) {
    container.innerHTML = `
      <div class="empty-state empty-illustrated">
        <div class="empty-icon empty-icon-globe">${ICON_GLOBE}</div>
        <h3>Aucun proxy pour l'instant</h3>
        <p>Attachez un proxy à un profil pour router son trafic — chaque machine de l'équipe l'utilise avec son propre réseau.</p>
        <button type="button" class="primary empty-cta">+ Nouveau proxy</button>
      </div>`;
    container.querySelector('.empty-cta').addEventListener('click', () => openProxyModal(null));
    return;
  }
  container.innerHTML = '';
  for (const proxy of items) {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div class="list-row-icon">${ICON_GLOBE}</div>
      <div class="list-row-main">
        <div class="list-row-title">${escapeHtml(proxy.label)}</div>
        <div class="list-row-sub mono">${escapeHtml(proxy.server)}${proxy.username ? ` · ${escapeHtml(proxy.username)}` : ''}</div>
      </div>
      <button type="button" class="list-row-edit">Modifier</button>
      <button type="button" class="list-row-delete danger">Supprimer</button>
    `;
    row.querySelector('.list-row-edit').addEventListener('click', () => openProxyModal(proxy));
    row.querySelector('.list-row-delete').addEventListener('click', async (e) => {
      try {
        await withBusy(e.currentTarget, () => window.smonster.proxies.delete(teamStore.get().currentTeamId, proxy.id));
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    container.appendChild(row);
  }
}
proxiesStore.subscribe(renderProxyList);

// --- Rendu : membres + permissions granulaires ------------------------------------------------

const GRANULAR_PERMISSIONS = ['profiles:create', 'profiles:edit', 'profiles:delete', 'proxies:create', 'proxies:edit', 'proxies:delete'];
const PERMISSION_LABELS = {
  'profiles:create': 'Créer des profils',
  'profiles:edit': 'Modifier des profils',
  'profiles:delete': 'Supprimer des profils',
  'proxies:create': 'Créer des proxys',
  'proxies:edit': 'Modifier des proxys',
  'proxies:delete': 'Supprimer des proxys',
};

function renderMemberStats() {
  const container = document.getElementById('memberStats');
  const items = membersStore.get().items;
  const admins = items.filter((m) => m.role === 'TEAM_ADMIN').length;
  const tiles = [
    { label: 'Membres', value: items.length, tone: '' },
    { label: 'Admins', value: admins, tone: 'accent' },
    { label: 'Membres simples', value: items.length - admins, tone: 'green' },
  ];
  container.innerHTML = tiles
    .map((t) => `<div class="stat-tile"><div class="stat-value ${t.tone}">${t.value}</div><div class="stat-label">${t.label}</div></div>`)
    .join('');
}

function renderMemberList() {
  const container = document.getElementById('memberList');
  const items = membersStore.get().items;
  renderMemberStats();
  container.innerHTML = '';
  for (const member of items) {
    const row = document.createElement('div');
    row.className = 'list-row member-row';
    // Le rôle TEAM_ADMIN parle déjà de lui-même via le badge (cf. role-pill ci-dessous) - une
    // ligne "Tous droits (TEAM_ADMIN)" en plus en dessous était redondante et trop voyante
    // (texte brut à underscore, couleur accent) pour l'information qu'elle ajoutait.
    const permsHtml =
      member.role === 'MEMBER'
        ? `<div class="member-permissions">${GRANULAR_PERMISSIONS.map(
            (p) =>
              `<button type="button" class="permission-chip${member.permissions.includes(p) ? ' granted' : ''}" data-permission="${p}">${PERMISSION_LABELS[p]}</button>`
          ).join('')}</div>`
        : '';
    row.innerHTML = `
      <div class="avatar-circle">${escapeHtml((member.displayName || '?').trim().charAt(0).toUpperCase())}</div>
      <div class="list-row-main">
        <div class="list-row-title">${escapeHtml(member.displayName)} <span class="role-pill role-pill-${member.role === 'TEAM_ADMIN' ? 'admin' : 'member'}">${TEAM_ROLE_LABEL[member.role] || member.role}</span></div>
        <div class="list-row-sub">${escapeHtml(member.email)}</div>
        ${permsHtml}
      </div>
    `;
    row.querySelectorAll('.permission-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        const permission = chip.dataset.permission;
        const wasGranted = chip.classList.contains('granted');
        const teamId = teamStore.get().currentTeamId;
        chip.classList.toggle('granted');
        try {
          if (wasGranted) {
            await window.smonster.teams.revokePermission(teamId, member.membershipId, permission);
          } else {
            await window.smonster.teams.grantPermission(teamId, member.membershipId, permission);
          }
        } catch (err) {
          chip.classList.toggle('granted');
          toast(err.message, 'error');
        }
      });
    });
    container.appendChild(row);
  }
}
membersStore.subscribe(renderMemberList);

// --- Navigation sidebar ------------------------------------------------------------------------

document.querySelectorAll('.sidebar-nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.section;
    document.querySelectorAll('.content-section').forEach((s) => (s.hidden = s.id !== `section-${target}`));
  });
});

// --- Modale : profil -----------------------------------------------------------------------

let pfDeviceWidget, pfHeadlessWidget, pfProxyWidget, pfLocaleWidget, pfTzWidget, editingProfileId = null;
let currentExtensionPaths = [];

/** Reflète les sélections ACTUELLES du formulaire (pas encore forcément enregistrées) - utile
 * dès la création d'un profil, pas seulement en édition, contrairement à Santé/Données qui ont
 * besoin d'un profil déjà existant sur disque. Pas d'appel réseau : `host.engineForDevice` est
 * une simple lecture locale (cf. `resolveEngineForDevice` dans driverBuilder.ts), le reste est
 * dérivé des widgets eux-mêmes. */
async function renderOverview() {
  const engine = await window.smonster.host.engineForDevice(pfDeviceWidget.value);
  document.getElementById('pfOverviewEngine').textContent = engine === 'webkit' ? 'WebKit (Safari)' : 'Chromium (Chrome)';
  document.getElementById('pfOverviewTz').textContent =
    pfTzWidget.value === 'auto' ? 'Automatique (résolu depuis le proxy au lancement)' : pfTzWidget.value;
  document.getElementById('pfOverviewLocale').textContent =
    pfLocaleWidget.value === 'auto' ? 'Automatique (résolu depuis le proxy au lancement)' : pfLocaleWidget.value;
  refreshExtensionsVisibility(engine);
}

function refreshExtensionsVisibility(engine) {
  // Électron uniquement pour la liste des extensions elles-mêmes (toujours locale à cette
  // machine), mais la VISIBILITÉ du champ dépend du moteur : charger une extension Chromium n'a
  // aucun sens pour un profil WebKit (API absente, cf. doc de `DriverBuilderOptions.extensionPaths`).
  document.getElementById('pfExtensionsField').hidden = !editingProfileId || engine === 'webkit';
}

function renderExtensionsList() {
  const container = document.getElementById('pfExtensionsList');
  container.innerHTML = currentExtensionPaths
    .map(
      (p) => `
    <div class="extension-row">
      <span class="extension-row-path" title="${escapeHtml(p)}">${escapeHtml(p)}</span>
      <button type="button" class="extension-row-remove" data-path="${escapeHtml(p)}">✕</button>
    </div>`
    )
    .join('');
  container.querySelectorAll('.extension-row-remove').forEach((btn) => {
    btn.addEventListener('click', async () => {
      currentExtensionPaths = currentExtensionPaths.filter((p) => p !== btn.dataset.path);
      await window.smonster.profiles.setExtensions(editingProfileId, currentExtensionPaths);
      renderExtensionsList();
    });
  });
}

async function loadExtensions(profile) {
  currentExtensionPaths = profile ? await window.smonster.profiles.getExtensions(profile.id) : [];
  renderExtensionsList();
}

function initProfileModal() {
  pfDeviceWidget = createSelect({
    options: DEVICE_PRESETS,
    value: 'desktop',
    onChange: (v) => {
      updateDevicePlatformHint(v, 'pfDevicePlatformHint');
      renderOverview();
    },
  });
  document.getElementById('pfDeviceContainer').appendChild(pfDeviceWidget);
  pfHeadlessWidget = createCheckbox({ checked: false, variant: 'switch' });
  document.getElementById('pfHeadlessContainer').appendChild(pfHeadlessWidget);
  // "auto" en premier et par défaut : DriverBuilder résout alors la locale/le fuseau depuis
  // l'IP de sortie du proxy attaché à chaque lancement (jamais figé une fois pour toutes - si le
  // proxy change, le fuseau/la langue suivent), cf. `resolveGeoFromProxy` dans driverBuilder.ts.
  // Sans proxy (ou si la résolution échoue), retombe sur les mêmes défauts qu'avant (fr-FR /
  // Europe/Paris) - jamais bloquant.
  pfLocaleWidget = createSelect({ options: [{ value: 'auto', label: 'Automatique (détecté depuis le proxy)' }, ...LOCALE_PRESETS], value: 'auto' });
  pfLocaleWidget.addEventListener('change', renderOverview);
  document.getElementById('pfLocaleContainer').appendChild(pfLocaleWidget);
  pfTzWidget = createSelect({ options: [{ value: 'auto', label: 'Automatique (détecté depuis le proxy)' }, ...TIMEZONE_OPTIONS], value: 'auto' });
  pfTzWidget.addEventListener('change', renderOverview);
  document.getElementById('pfTzContainer').appendChild(pfTzWidget);
  pfProxyWidget = createSelect({ options: [{ value: '', label: 'Aucun' }], value: '' });
  document.getElementById('pfProxyContainer').appendChild(pfProxyWidget);

  proxiesStore.subscribe((s) => {
    const options = [{ value: '', label: 'Aucun' }, ...s.items.map((p) => ({ value: p.id, label: p.label }))];
    const current = pfProxyWidget.value;
    pfProxyWidget.replaceWith((pfProxyWidget = createSelect({ options, value: options.some((o) => o.value === current) ? current : '' })));
  });

  document.getElementById('pfAddExtensionBtn').addEventListener('click', async () => {
    const folder = await window.smonster.profiles.pickExtensionFolder();
    if (!folder || currentExtensionPaths.includes(folder)) return;
    currentExtensionPaths = [...currentExtensionPaths, folder];
    await window.smonster.profiles.setExtensions(editingProfileId, currentExtensionPaths);
    renderExtensionsList();
  });
}

/** Ex-page `profile.html` (avant la réécriture Electron) : dossier local + taille du cache +
 * état de synchro partagé. Chargé à part (pas dans `openProfileModal`'s flow principal) car ça
 * suppose un aller-retour IPC — ne doit jamais retarder/bloquer l'ouverture de la modale elle-même. */
function describeLiveStatus(profile, isRunningHere) {
  if (isRunningHere) return 'En cours sur cette machine';
  if (profile.inUseBy) {
    const member = membersStore.get().items.find((m) => m.userId === profile.inUseBy.userId);
    const who = member ? member.displayName : profile.inUseBy.machineLabel || 'un autre membre';
    return `En cours par ${who}${profile.inUseBy.machineLabel ? ` (${profile.inUseBy.machineLabel})` : ''}`;
  }
  return 'Disponible';
}

function describeLastLaunch(lastLaunch) {
  if (!lastLaunch) return 'Jamais lancé sur cette machine';
  const when = new Date(lastLaunch.at).toLocaleString('fr-FR');
  return lastLaunch.ok ? `OK · ${when}` : `Échec · ${when} — ${lastLaunch.error || 'erreur inconnue'}`;
}

async function loadDiskInfo(profile) {
  const section = document.getElementById('pfDiskInfo');
  const proxyRow = document.getElementById('pfProxyRow');
  if (!profile) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  document.getElementById('pfFolderPath').textContent = '…';
  document.getElementById('pfCacheSize').textContent = '…';
  document.getElementById('pfStateSize').textContent = '…';
  document.getElementById('pfLastLaunch').textContent = '…';
  document.getElementById('pfStateInfo').textContent =
    profile.stateUpdatedAt ? `v${profile.stateVersion} · ${new Date(profile.stateUpdatedAt).toLocaleString('fr-FR')}` : 'Jamais synchronisé';
  proxyRow.hidden = !profile.proxyId;
  if (profile.proxyId) document.getElementById('pfProxyStatus').textContent = 'Non testé';

  const isRunningHere = await window.smonster.profiles.isRunning(profile.id);
  if (editingProfileId !== profile.id) return;
  document.getElementById('pfLiveStatus').textContent = describeLiveStatus(profile, isRunningHere);

  try {
    const record = await toCloudRecord(profile);
    const info = await window.smonster.profiles.diskInfo(record);
    // L'utilisateur a pu fermer la modale (ou en ouvrir une autre) pendant l'aller-retour IPC -
    // n'écrit dans le DOM que si cette modale est toujours celle qui est ouverte pour ce profil.
    if (editingProfileId !== profile.id) return;
    document.getElementById('pfFolderPath').textContent = info.folderPath;
    document.getElementById('pfCacheSize').textContent = formatBytes(info.cacheBytes);
    document.getElementById('pfStateSize').textContent = formatBytes(info.stateBytes);
    document.getElementById('pfLastLaunch').textContent = describeLastLaunch(info.lastLaunch);
  } catch (err) {
    document.getElementById('pfFolderPath').textContent = '—';
    document.getElementById('pfCacheSize').textContent = '—';
    document.getElementById('pfStateSize').textContent = '—';
    document.getElementById('pfLastLaunch').textContent = '—';
    toast(err.message, 'error');
  }
}

function openProfileModal(profile) {
  editingProfileId = profile ? profile.id : null;
  document.getElementById('profileModalTitle').textContent = profile ? 'Modifier le profil' : 'Nouveau profil';
  document.getElementById('pfName').value = profile ? profile.name : '';
  pfDeviceWidget.value = profile ? profile.device : 'desktop';
  updateDevicePlatformHint(pfDeviceWidget.value, 'pfDevicePlatformHint');
  pfHeadlessWidget.checked = profile ? profile.headlessDefault : false;
  pfLocaleWidget.value = profile ? profile.locale : 'auto';
  pfTzWidget.value = profile ? profile.timezoneId : 'auto';
  pfProxyWidget.value = profile && profile.proxyId ? profile.proxyId : '';
  document.getElementById('profileModal').classList.add('visible');
  loadDiskInfo(profile);
  loadExtensions(profile);
  renderOverview();
}
function closeProfileModal() {
  document.getElementById('profileModal').classList.remove('visible');
}

document.getElementById('pfClearCacheBtn').addEventListener('click', async (e) => {
  const profile = profilesStore.get().items.find((p) => p.id === editingProfileId);
  if (!profile) return;
  try {
    await withBusy(e.currentTarget, async () => {
      const record = await toCloudRecord(profile);
      await window.smonster.profiles.clearCache(record);
    });
    toast('Cache vidé.');
    loadDiskInfo(profile);
  } catch (err) {
    toast(err.message, 'error');
  }
});

/** Résultat de `window.smonster.profiles.testProxy(...)` -> texte court (ex. "OK · 1,2s ·
 * US, New York"), partagé entre le bouton "Tester" de la modale profil et "Vérifier" de la
 * modale proxy elle-même. */
function formatProxyResult(result) {
  if (!result.ok) return `Injoignable — ${result.error}`;
  const place = [result.city, result.country].filter(Boolean).join(', ');
  return `OK · ${(result.latencyMs / 1000).toFixed(1)}s${place ? ` · ${place}` : ''}`;
}

document.getElementById('pfTestProxyBtn').addEventListener('click', async (e) => {
  const profile = profilesStore.get().items.find((p) => p.id === editingProfileId);
  const statusEl = document.getElementById('pfProxyStatus');
  if (!profile || !profile.proxyId) return;
  statusEl.textContent = 'Test en cours…';
  try {
    await withBusy(e.currentTarget, async () => {
      const proxy = await window.smonster.proxies.get(profile.teamId, profile.proxyId);
      const result = await window.smonster.profiles.testProxy({ server: proxy.server, username: proxy.username || undefined, password: proxy.password || undefined });
      statusEl.textContent = formatProxyResult(result);
    });
  } catch (err) {
    statusEl.textContent = 'Erreur de test';
    toast(err.message, 'error');
  }
});

document.getElementById('newProfileBtn').addEventListener('click', () => openProfileModal(null));
document.getElementById('profileCancel').addEventListener('click', closeProfileModal);
document.getElementById('profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const teamId = teamStore.get().currentTeamId;
  const input = {
    name: document.getElementById('pfName').value.trim(),
    device: pfDeviceWidget.value,
    headlessDefault: pfHeadlessWidget.checked,
    locale: pfLocaleWidget.value,
    timezoneId: pfTzWidget.value,
    proxyId: pfProxyWidget.value || null,
  };
  try {
    await withBusy(e.target.querySelector('button[type=submit]'), () =>
      editingProfileId ? window.smonster.profiles.update(teamId, editingProfileId, input) : window.smonster.profiles.create(teamId, input)
    );
    closeProfileModal();
    loadProfiles();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// --- Modale : proxy ------------------------------------------------------------------------

let editingProxyId = null;

function openProxyModal(proxy) {
  editingProxyId = proxy ? proxy.id : null;
  document.getElementById('proxyForm').reset();
  document.getElementById('proxyModalTitle').textContent = proxy ? 'Modifier le proxy' : 'Nouveau proxy';
  document.getElementById('pxLabel').value = proxy ? proxy.label : '';
  document.getElementById('pxServer').value = proxy ? proxy.server : '';
  document.getElementById('pxUsername').value = proxy && proxy.username ? proxy.username : '';
  // Jamais pré-rempli, même en édition (cf. submit handler) : un champ vide veut dire "ne pas
  // changer", pas "mot de passe effacé" - et ça évite d'afficher un mot de passe déchiffré en
  // clair dans un champ texte par défaut.
  document.getElementById('pxPasswordLabel').textContent = proxy ? 'Mot de passe (laisser vide pour ne pas changer)' : 'Mot de passe';
  document.getElementById('pxCheckResult').hidden = true;
  document.getElementById('proxyModal').classList.add('visible');
}

document.getElementById('newProxyBtn').addEventListener('click', () => openProxyModal(null));
document.getElementById('proxyCancel').addEventListener('click', () => document.getElementById('proxyModal').classList.remove('visible'));
document.getElementById('proxyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const teamId = teamStore.get().currentTeamId;
  const password = document.getElementById('pxPassword').value;
  const input = {
    label: document.getElementById('pxLabel').value.trim(),
    server: document.getElementById('pxServer').value.trim(),
    username: document.getElementById('pxUsername').value.trim() || null,
    // Édition + champ vide -> clé omise entièrement (garde le mot de passe existant tel quel).
    // Création + champ vide -> `null` explicite (aucun mot de passe pour ce nouveau proxy).
    ...(editingProxyId ? (password ? { password } : {}) : { password: password || null }),
  };
  try {
    await withBusy(e.target.querySelector('button[type=submit]'), () =>
      editingProxyId ? window.smonster.proxies.update(teamId, editingProxyId, input) : window.smonster.proxies.create(teamId, input)
    );
    document.getElementById('proxyModal').classList.remove('visible');
    loadProxies();
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('pxCheckBtn').addEventListener('click', async () => {
  const resultEl = document.getElementById('pxCheckResult');
  const server = document.getElementById('pxServer').value.trim();
  if (!server) {
    toast('Renseigne au moins le serveur avant de vérifier.', 'error');
    return;
  }
  let username = document.getElementById('pxUsername').value.trim() || undefined;
  let password = document.getElementById('pxPassword').value || undefined;
  if (editingProxyId && !password) {
    // Champ laissé vide = "ne pas changer" (cf. submit handler) - pour un test fidèle à ce qui
    // sera réellement utilisé, va chercher le VRAI mot de passe stocké plutôt que de tester sans
    // authentification (faux négatif si le proxy en exige une).
    try {
      const stored = await window.smonster.proxies.get(teamStore.get().currentTeamId, editingProxyId);
      password = stored.password || undefined;
      username = stored.username || username;
    } catch {
      // Best-effort : si cet appel échoue, on teste quand même avec ce qu'il y a dans le formulaire.
    }
  }
  resultEl.hidden = false;
  resultEl.innerHTML = '<div class="disk-info-row"><span class="disk-info-value disk-info-muted">Test en cours…</span></div>';
  try {
    const result = await window.smonster.profiles.testProxy({ server, username, password });
    if (!result.ok) {
      resultEl.innerHTML = `<div class="disk-info-row"><span class="disk-info-value disk-info-danger">Injoignable — ${escapeHtml(result.error)}</span></div>`;
      return;
    }
    resultEl.innerHTML = `
      <div class="disk-info-row"><span class="disk-info-label">IP</span><span class="disk-info-value mono">${escapeHtml(result.ip || '—')}</span></div>
      <div class="disk-info-row"><span class="disk-info-label">Lieu</span><span class="disk-info-value">${escapeHtml([result.city, result.region, result.country].filter(Boolean).join(', ') || '—')}</span></div>
      <div class="disk-info-row"><span class="disk-info-label">Coord.</span><span class="disk-info-value mono">${result.lat != null ? `${result.lat}, ${result.lon}` : '—'}</span></div>
      <div class="disk-info-row"><span class="disk-info-label">Fuseau</span><span class="disk-info-value">${escapeHtml(result.timezone || '—')}</span></div>
      <div class="disk-info-row"><span class="disk-info-label">Latence</span><span class="disk-info-value">${result.latencyMs} ms</span></div>
    `;
  } catch (err) {
    resultEl.innerHTML = `<div class="disk-info-row"><span class="disk-info-value disk-info-danger">${escapeHtml(err.message)}</span></div>`;
  }
});

// --- Modale : inviter ----------------------------------------------------------------------

let inviteRoleWidget;
function initInviteModal() {
  inviteRoleWidget = createSelect({ options: [{ value: 'MEMBER', label: 'Membre' }, { value: 'TEAM_ADMIN', label: 'Admin de la team' }], value: 'MEMBER' });
  document.getElementById('inviteRoleContainer').appendChild(inviteRoleWidget);
}
document.getElementById('inviteMemberBtn').addEventListener('click', () => {
  document.getElementById('inviteForm').reset();
  document.getElementById('inviteResult').hidden = true;
  document.getElementById('inviteSubmit').hidden = false;
  document.getElementById('inviteModal').classList.add('visible');
});
document.getElementById('inviteCancel').addEventListener('click', () => document.getElementById('inviteModal').classList.remove('visible'));
document.getElementById('inviteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const teamId = teamStore.get().currentTeamId;
  const email = document.getElementById('inviteEmail').value.trim();
  try {
    const { token } = await withBusy(e.target.querySelector('button[type=submit]'), () => window.smonster.teams.invite(teamId, email, inviteRoleWidget.value));
    document.getElementById('inviteTokenValue').textContent = token;
    document.getElementById('inviteResult').hidden = false;
    document.getElementById('inviteSubmit').hidden = true;
  } catch (err) {
    toast(err.message, 'error');
  }
});
document.getElementById('copyInviteToken').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('inviteTokenValue').textContent);
  toast('Token copié.');
});

// --- Team switcher ---------------------------------------------------------------------------

/**
 * Composant dédié (pas le `createSelect` générique de widgets.js, réservé aux simples pickers
 * de formulaire) : ce déclencheur a besoin d'un badge icône + deux lignes de texte (nom + rôle),
 * et son panneau d'une liste "ÉQUIPES" avec coche sur l'actif — calqué sur l'AccountSwitcher de
 * cherryfruitz (components/shell/Sidebar.tsx), même structure, palette propre à smonster.
 */
function closeTeamSwitchPanel() {
  const panel = document.querySelector('.team-switch-panel');
  if (panel) panel.remove();
  const root = document.querySelector('.team-switch.open');
  if (root) root.classList.remove('open');
}

function openTeamSwitchPanel(root, trigger, teams, currentTeamId) {
  closeTeamSwitchPanel();
  const panel = document.createElement('div');
  panel.className = 'team-switch-panel';
  panel.innerHTML = `
    <div class="team-switch-label">Équipes</div>
    ${teams
      .map(
        (t) => `
      <button type="button" class="team-switch-item${t.team.id === currentTeamId ? ' active' : ''}" data-team-id="${t.team.id}">
        <span class="team-switch-item-badge">${ICON_TEAM}</span>
        <span class="team-switch-item-text">${escapeHtml(t.team.name)}</span>
        <span class="team-switch-item-role">${TEAM_ROLE_LABEL[t.role] || t.role}</span>
        ${t.team.id === currentTeamId ? `<span class="team-switch-check">${ICON_CHECK}</span>` : ''}
      </button>`
      )
      .join('')}
  `;
  document.body.appendChild(panel);
  const rect = trigger.getBoundingClientRect();
  panel.style.left = `${rect.left}px`;
  panel.style.top = `${rect.bottom + 6}px`;
  panel.style.width = `${Math.max(rect.width, 220)}px`;
  root.classList.add('open');

  panel.querySelectorAll('.team-switch-item').forEach((item) => {
    item.addEventListener('click', () => {
      const teamId = item.dataset.teamId;
      closeTeamSwitchPanel();
      if (teamId !== currentTeamId) switchTeam(teamId);
    });
  });

  const onOutside = (e) => {
    if (!panel.contains(e.target) && !trigger.contains(e.target)) {
      closeTeamSwitchPanel();
      document.removeEventListener('click', onOutside);
    }
  };
  setTimeout(() => document.addEventListener('click', onOutside), 0);
}

function renderTeamSwitcher() {
  const { teams, currentTeamId } = teamStore.get();
  const container = document.getElementById('teamSwitcherContainer');
  container.innerHTML = '';
  closeTeamSwitchPanel();
  if (teams.length === 0) return;
  const active = teams.find((t) => t.team.id === currentTeamId) || teams[0];

  const root = document.createElement('div');
  root.className = 'team-switch';
  root.innerHTML = `
    <button type="button" class="team-switch-trigger">
      <span class="team-switch-badge">${ICON_TEAM}</span>
      <span class="team-switch-text">
        <span class="team-switch-name">${escapeHtml(active.team.name)}</span>
        <span class="team-switch-role">Équipe · ${TEAM_ROLE_LABEL[active.role] || active.role}</span>
      </span>
      <span class="team-switch-chevron">${ICON_CHEVRONS_UPDOWN}</span>
    </button>
  `;
  const trigger = root.querySelector('.team-switch-trigger');
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (document.querySelector('.team-switch-panel')) {
      closeTeamSwitchPanel();
    } else {
      openTeamSwitchPanel(root, trigger, teams, currentTeamId);
    }
  });
  container.appendChild(root);
}
function renderTeamSettingsPanel() {
  const team = currentTeam();
  const nameEl = document.getElementById('teamSettingsName');
  const roleEl = document.getElementById('teamSettingsRole');
  const input = document.getElementById('teamRenameInput');
  if (!team) {
    nameEl.textContent = '—';
    roleEl.textContent = '';
    input.value = '';
    return;
  }
  nameEl.textContent = team.team.name;
  roleEl.textContent =
    team.role === 'TEAM_ADMIN' ? "Votre rôle : Admin — tous droits, y compris la suppression de l'équipe" : 'Votre rôle : Membre';
  input.value = team.team.name;
}

teamStore.subscribe(() => {
  renderTeamSwitcher();
  renderTeamSettingsPanel();
  document.getElementById('navMembers').hidden = !canManageTeam();
  const hasTeam = teamStore.get().teams.length > 0;
  document.getElementById('noTeamState').hidden = hasTeam;
  document.getElementById('teamContent').hidden = !hasTeam;
});

document.getElementById('teamRenameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const teamId = teamStore.get().currentTeamId;
  const name = document.getElementById('teamRenameInput').value.trim();
  try {
    const updated = await withBusy(e.target.querySelector('button[type=submit]'), () => window.smonster.teams.rename(teamId, name));
    teamStore.set((s) => ({ ...s, teams: s.teams.map((t) => (t.team.id === teamId ? { ...t, team: updated } : t)) }));
    toast('Équipe renommée.');
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('deleteTeamBtn').addEventListener('click', async (e) => {
  const team = currentTeam();
  if (!team) return;
  const confirmed = confirm(`Supprimer définitivement « ${team.team.name} » ? Profils, proxys et invitations seront perdus — action irréversible.`);
  if (!confirmed) return;
  try {
    await withBusy(e.currentTarget, () => window.smonster.teams.delete(team.team.id));
    const remaining = teamStore.get().teams.filter((t) => t.team.id !== team.team.id);
    teamStore.set({ teams: remaining, currentTeamId: remaining[0] ? remaining[0].team.id : null });
    if (remaining[0]) {
      await switchTeam(remaining[0].team.id);
    } else {
      profilesStore.set({ items: [], loading: false });
      proxiesStore.set({ items: [] });
      membersStore.set({ items: [] });
    }
    toast('Équipe supprimée.');
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('newTeamBtn').addEventListener('click', () => {
  document.getElementById('teamForm').reset();
  document.getElementById('teamModal').classList.add('visible');
});
document.getElementById('createFirstTeamBtn').addEventListener('click', () => {
  document.getElementById('teamForm').reset();
  document.getElementById('teamModal').classList.add('visible');
});
document.getElementById('teamCancel').addEventListener('click', () => document.getElementById('teamModal').classList.remove('visible'));
document.getElementById('teamForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('teamName').value.trim();
  try {
    const team = await withBusy(e.target.querySelector('button[type=submit]'), () => window.smonster.teams.create(name));
    document.getElementById('teamModal').classList.remove('visible');
    teamStore.set((s) => ({ ...s, teams: [...s.teams, { team, role: 'TEAM_ADMIN' }] }));
    await switchTeam(team.id);
  } catch (err) {
    toast(err.message, 'error');
  }
});

// --- Mon compte (profil, mot de passe, 2FA) -----------------------------------------------------

let accountState = null;

async function loadAccount() {
  try {
    accountState = await window.smonster.account.get();
    document.getElementById('acctDisplayName').value = accountState.displayName;
    renderAccount2fa();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderAccount2fa() {
  if (!accountState) return;
  const totpBtn = document.getElementById('acct2faTotpBtn');
  document.getElementById('acct2faTotpStatus').textContent = accountState.totpEnabled ? 'Activée' : 'Désactivée';
  totpBtn.textContent = accountState.totpEnabled ? 'Désactiver' : 'Activer';
  totpBtn.className = accountState.totpEnabled ? 'danger' : '';

  const emailBtn = document.getElementById('acct2faEmailBtn');
  const emailBlocked = !accountState.emailOtpEnabled && !accountState.canSendMail;
  document.getElementById('acct2faEmailStatus').textContent = accountState.emailOtpEnabled ? 'Activé' : 'Désactivé';
  emailBtn.textContent = accountState.emailOtpEnabled ? 'Désactiver' : 'Activer';
  emailBtn.className = accountState.emailOtpEnabled ? 'danger' : '';
  emailBtn.disabled = emailBlocked;
  emailBtn.title = emailBlocked ? "Envoi d'email non configuré côté serveur" : '';
}

document.getElementById('accountProfileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await withBusy(e.target.querySelector('button[type=submit]'), () => window.smonster.account.updateProfile(document.getElementById('acctDisplayName').value.trim()));
    toast('Profil mis à jour.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('accountPasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const currentPassword = document.getElementById('acctCurrentPassword').value;
  const newPassword = document.getElementById('acctNewPassword').value;
  try {
    await withBusy(e.target.querySelector('button[type=submit]'), () => window.smonster.account.changePassword(currentPassword, newPassword));
    document.getElementById('accountPasswordForm').reset();
    toast('Mot de passe changé.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('acct2faTotpBtn').addEventListener('click', async (e) => {
  if (accountState?.totpEnabled) {
    document.getElementById('totpDisablePassword').value = '';
    document.getElementById('totpDisableError').hidden = true;
    document.getElementById('totpDisableModal').classList.add('visible');
    return;
  }
  try {
    const { secret, qrDataUrl } = await withBusy(e.currentTarget, () => window.smonster.account.totpSetup());
    document.getElementById('totpQrImage').src = qrDataUrl;
    document.getElementById('totpSecretText').textContent = secret;
    document.getElementById('totpEnableCode').value = '';
    document.getElementById('totpSetupError').hidden = true;
    document.getElementById('totpSetupModal').classList.add('visible');
  } catch (err) {
    toast(err.message, 'error');
  }
});
document.getElementById('totpSetupCancel').addEventListener('click', () => document.getElementById('totpSetupModal').classList.remove('visible'));
document.getElementById('totpSetupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('totpEnableCode').value.trim();
  const errorEl = document.getElementById('totpSetupError');
  errorEl.hidden = true;
  try {
    await withBusy(e.target.querySelector('button[type=submit]'), () => window.smonster.account.totpEnable(code));
    document.getElementById('totpSetupModal').classList.remove('visible');
    toast('Authentification par application activée.', 'success');
    await loadAccount();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

document.getElementById('totpDisableCancel').addEventListener('click', () => document.getElementById('totpDisableModal').classList.remove('visible'));
document.getElementById('totpDisableForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('totpDisablePassword').value;
  const errorEl = document.getElementById('totpDisableError');
  errorEl.hidden = true;
  try {
    await withBusy(e.target.querySelector('button[type=submit]'), () => window.smonster.account.totpDisable(password));
    document.getElementById('totpDisableModal').classList.remove('visible');
    toast('Authentification par application désactivée.', 'success');
    await loadAccount();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

document.getElementById('acct2faEmailBtn').addEventListener('click', async (e) => {
  if (!accountState) return;
  const nextEnabled = !accountState.emailOtpEnabled;
  try {
    await withBusy(e.currentTarget, () => window.smonster.account.setEmailOtp(nextEnabled));
    toast(nextEnabled ? 'Code par email activé.' : 'Code par email désactivé.', 'success');
    await loadAccount();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// --- Auth : connexion / invitation / session --------------------------------------------------

function showAppView(claims) {
  authStore.set({ claims });
  document.getElementById('loginView').hidden = true;
  document.getElementById('appView').hidden = false;
  document.getElementById('currentUserLabel').textContent = claims.displayName;
  document.getElementById('currentUserEmail').textContent = claims.email;
  document.getElementById('sidebarUserAvatar').textContent = (claims.displayName || '?').trim().charAt(0).toUpperCase();
  document.getElementById('titlebarStatus').textContent = claims.displayName;
  document.getElementById('titlebarConn').hidden = false;
}

function showLoginView() {
  authStore.set({ claims: null });
  document.getElementById('loginView').hidden = false;
  document.getElementById('appView').hidden = true;
  document.getElementById('titlebarStatus').textContent = '';
  document.getElementById('titlebarConn').hidden = true;
}

async function bootstrapAfterAuth(claims) {
  showAppView(claims);
  loadAccount(); // propriété du compte, pas d'une team — indépendant de ce qui suit
  try {
    const teams = await window.smonster.teams.list();
    teamStore.set({ teams, currentTeamId: teams[0] ? teams[0].team.id : null });
    if (teams[0]) await switchTeam(teams[0].team.id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

let pendingMfaChallenge = null;

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errorEl = document.getElementById('loginError');
  errorEl.hidden = true;
  try {
    await withBusy(e.target.querySelector('button[type=submit]'), async () => {
      const result = await window.smonster.auth.login(email, password);
      if (result.mfaRequired) {
        pendingMfaChallenge = result.challenge;
        document.getElementById('mfaMethodHint').textContent =
          result.method === 'totp'
            ? "Entre le code à 6 chiffres de ton application d'authentification."
            : 'Entre le code à 6 chiffres envoyé par email.';
        document.getElementById('mfaCode').value = '';
        document.getElementById('mfaError').hidden = true;
        document.getElementById('loginForm').hidden = true;
        document.getElementById('mfaForm').hidden = false;
        document.getElementById('mfaCode').focus();
        return;
      }
      await bootstrapAfterAuth(result.claims);
    });
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

document.getElementById('mfaForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('mfaCode').value.trim();
  const errorEl = document.getElementById('mfaError');
  errorEl.hidden = true;
  try {
    await withBusy(e.target.querySelector('button[type=submit]'), async () => {
      const claims = await window.smonster.auth.verifyMfa(pendingMfaChallenge, code);
      pendingMfaChallenge = null;
      document.getElementById('mfaForm').hidden = true;
      document.getElementById('loginForm').hidden = false;
      await bootstrapAfterAuth(claims);
    });
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});
document.getElementById('mfaCancel').addEventListener('click', () => {
  pendingMfaChallenge = null;
  document.getElementById('mfaForm').hidden = true;
  document.getElementById('loginForm').hidden = false;
});

document.getElementById('showAcceptInvite').addEventListener('click', () => {
  document.getElementById('loginForm').hidden = true;
  document.getElementById('acceptInviteForm').hidden = false;
});
document.getElementById('showLogin').addEventListener('click', () => {
  document.getElementById('acceptInviteForm').hidden = true;
  document.getElementById('loginForm').hidden = false;
});
document.getElementById('acceptInviteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = document.getElementById('inviteToken').value.trim();
  const displayName = document.getElementById('inviteDisplayName').value.trim() || undefined;
  const password = document.getElementById('invitePassword').value || undefined;
  const errorEl = document.getElementById('acceptInviteError');
  errorEl.hidden = true;
  try {
    await withBusy(e.target.querySelector('button[type=submit]'), async () => {
      const claims = await window.smonster.auth.acceptInvite(token, password, displayName);
      await bootstrapAfterAuth(claims);
    });
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

document.getElementById('logoutBtn').addEventListener('click', async (e) => {
  await withBusy(e.currentTarget, () => window.smonster.auth.logout());
  showLoginView();
});

// --- Démarrage -------------------------------------------------------------------------------

initTitlebar();
initProfileModal();
initInviteModal();

(async () => {
  try {
    const claims = await window.smonster.auth.restoreSession();
    if (claims) {
      await bootstrapAfterAuth(claims);
    } else {
      showLoginView();
    }
  } catch (err) {
    showLoginView();
    toast(err.message, 'error');
  }
})();
