// Page réglages d'un profil unique : ?id=<uuid> dans l'URL.

const params = new URLSearchParams(location.search);
const profileId = params.get('id');

if (!profileId) {
  document.body.innerHTML = '<p style="padding:24px">Aucun profil spécifié (paramètre <code>id</code> manquant).</p>';
  throw new Error('id manquant');
}

let current = null;

const fHeadlessWidget = createCheckbox({ variant: 'switch', title: 'Lancer sans interface graphique' });
document.getElementById('fHeadlessContainer').appendChild(fHeadlessWidget);

const fDeviceWidget = createSelect({ options: DEVICE_PRESETS });
document.getElementById('fDeviceContainer').appendChild(fDeviceWidget);

const fLocaleWidget = createSelect({ options: LOCALE_PRESETS });
document.getElementById('fLocaleContainer').appendChild(fLocaleWidget);

const fTzWidget = createSelect({ options: TIMEZONE_OPTIONS });
document.getElementById('fTzContainer').appendChild(fTzWidget);

async function load() {
  try {
    current = await api(`/api/profiles/${encodeURIComponent(profileId)}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  render();

  try {
    const cache = await api(`/api/profiles/${encodeURIComponent(profileId)}/cache`);
    document.getElementById('folderPath').textContent = cache.path;
    document.getElementById('cacheInfo').textContent = `${formatBytes(cache.sizeBytes)} — ${cache.fileCount} fichier(s)`;
  } catch (err) {
    toast(err.message, 'error');
  }
}

function render() {
  const p = current;
  document.getElementById('pageTitle').textContent = p.name;
  document.title = `smonster — ${p.name}`;

  const health = p.running
    ? p.connected
      ? { dot: 'green', label: 'connecté' }
      : { dot: 'red', label: 'déconnecté' }
    : p.lastLaunchResult
      ? p.lastLaunchResult.ok
        ? { dot: 'yellow', label: 'dernier lancement OK' }
        : { dot: 'red', label: `dernier lancement en échec : ${escapeHtml(p.lastLaunchResult.error || '')}` }
      : { dot: '', label: 'jamais lancé' };

  document.getElementById('statusBadges').innerHTML = `
    <span class="badge"><span class="dot ${p.running ? 'green' : ''}"></span>${p.running ? 'actif' : 'arrêté'}</span>
    <span class="badge"><span class="dot ${health.dot}"></span>${health.label}</span>
  `;
  document.getElementById('runningNotice').style.display = p.running ? 'block' : 'none';
  document.getElementById('toggleBtn').textContent = p.running ? 'Stopper' : 'Lancer';

  document.getElementById('fName').value = p.name;
  fHeadlessWidget.checked = p.headless;
  fDeviceWidget.value = p.device;
  fLocaleWidget.value = p.locale;
  fTzWidget.value = p.timezoneId;
  document.getElementById('fProxyServer').value = (p.proxy && p.proxy.server) || '';
  document.getElementById('fProxyUser').value = (p.proxy && p.proxy.username) || '';
  document.getElementById('fProxyPass').value = (p.proxy && p.proxy.password) || '';
  document.getElementById('fProxyRotation').value = (p.proxy && p.proxy.rotationUrl) || '';
}

document.getElementById('toggleBtn').addEventListener('click', async () => {
  try {
    current = await api(`/api/profiles/${encodeURIComponent(profileId)}/${current.running ? 'stop' : 'launch'}`, {
      method: 'POST',
    });
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('clearCacheBtn').addEventListener('click', () => {
  if (!confirm(`Vider le cache de "${current.name}" ?`)) return;
  api(`/api/profiles/${encodeURIComponent(profileId)}/clear-cache`, { method: 'POST' })
    .then(() => {
      toast('Cache vidé.');
      return load();
    })
    .catch((err) => toast(err.message, 'error'));
});

document.getElementById('deleteBtn').addEventListener('click', () => {
  if (!confirm(`Supprimer définitivement "${current.name}" ? Cette action est irréversible.`)) return;
  api(`/api/profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' })
    .then(() => {
      location.href = 'index.html';
    })
    .catch((err) => toast(err.message, 'error'));
});

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const server = document.getElementById('fProxyServer').value.trim();
  const patch = {
    name: document.getElementById('fName').value.trim(),
    headless: fHeadlessWidget.checked,
    device: fDeviceWidget.value,
    locale: fLocaleWidget.value,
    timezoneId: fTzWidget.value,
    proxy: server
      ? {
          server,
          username: document.getElementById('fProxyUser').value.trim() || undefined,
          password: document.getElementById('fProxyPass').value.trim() || undefined,
          rotationUrl: document.getElementById('fProxyRotation').value.trim() || undefined,
        }
      : null,
  };
  try {
    current = await api(`/api/profiles/${encodeURIComponent(profileId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    toast('Réglages enregistrés.');
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
});

load();
