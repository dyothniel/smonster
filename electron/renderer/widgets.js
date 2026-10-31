// Widgets personnalisés remplaçant les contrôles natifs du navigateur (peu stylables) :
// case à cocher / interrupteur (createCheckbox) et menu déroulant filtrable (createSelect).
// Purs DOM/vanilla JS, pas de dépendance — cohérent avec le reste du dashboard.

/**
 * Case à cocher personnalisée. `variant`: 'checkbox' (case carrée, pour la sélection multiple
 * dans la grille) ou 'switch' (interrupteur, pour un réglage booléen comme `headless`).
 * Expose `.checked` (get/set) comme un vrai `<input type=checkbox>`, plus `role="checkbox"` et
 * `aria-checked` pour l'accessibilité clavier/lecteur d'écran.
 */
function createCheckbox({ checked = false, variant = 'checkbox', onChange, id, title } = {}) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `xcheckbox xcheckbox-${variant}`;
  el.setAttribute('role', 'checkbox');
  if (id) el.id = id;
  if (title) el.title = title;

  el.innerHTML =
    variant === 'switch'
      ? '<span class="xcheckbox-knob"></span>'
      : '<svg class="xcheckbox-check" viewBox="0 0 16 16" fill="none"><path d="M3 8.5L6.2 12L13 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  let state = checked;
  function apply() {
    el.classList.toggle('checked', state);
    el.setAttribute('aria-checked', String(state));
  }
  apply();

  el.addEventListener('click', () => {
    state = !state;
    apply();
    if (onChange) onChange(state);
  });

  Object.defineProperty(el, 'checked', {
    get() {
      return state;
    },
    set(v) {
      state = !!v;
      apply();
    },
  });

  return el;
}

function closeAllXSelectPanels() {
  document.querySelectorAll('.xselect-panel').forEach((p) => p.remove());
  document.querySelectorAll('.xselect.open').forEach((el) => el.classList.remove('open'));
}
// Ferme le panneau si la page/le conteneur DERRIÈRE lui scrolle (il se désaligne de son
// déclencheur, `position: fixed`) — mais surtout pas si le scroll vient du panneau lui-même
// (sa propre liste d'options ou son champ de recherche), sinon impossible d'y scroller : le
// scroll d'un élément interne remonte bien en phase de capture jusqu'à `document`.
document.addEventListener(
  'scroll',
  (e) => {
    const panel = document.querySelector('.xselect-panel');
    if (panel && panel.contains(e.target)) return;
    closeAllXSelectPanels();
  },
  true
);

/**
 * Menu déroulant personnalisé, filtrable par recherche texte. `options`: tableau de strings ou
 * de `{ value, label }`. Expose `.value` (get/set) et un événement `change` (CustomEvent, detail
 * = nouvelle valeur), comme un `<select>` natif.
 */
function createSelect({ options, value, placeholder = 'Choisir…', searchable = true, onChange, id } = {}) {
  const normalized = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));

  const root = document.createElement('div');
  root.className = 'xselect';
  if (id) root.id = id;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'xselect-trigger';
  root.appendChild(button);

  let current = value !== undefined ? value : normalized[0] && normalized[0].value;
  let closePanel = null;

  function labelFor(v) {
    const found = normalized.find((o) => o.value === v);
    return found ? found.label : placeholder;
  }
  function renderTrigger() {
    button.textContent = labelFor(current);
    button.classList.toggle('placeholder', current === undefined || current === '');
  }
  renderTrigger();

  function openPanel() {
    closeAllXSelectPanels();
    const panel = document.createElement('div');
    panel.className = 'xselect-panel';

    let search = null;
    if (searchable && normalized.length > 6) {
      search = document.createElement('input');
      search.type = 'text';
      search.className = 'xselect-search';
      search.placeholder = 'Rechercher…';
      panel.appendChild(search);
    }
    const list = document.createElement('div');
    list.className = 'xselect-list';
    panel.appendChild(list);

    function renderList(filter) {
      list.innerHTML = '';
      const f = (filter || '').toLowerCase();
      const matches = normalized.filter((o) => !f || o.label.toLowerCase().includes(f));
      for (const opt of matches) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'xselect-option' + (opt.value === current ? ' selected' : '');
        item.textContent = opt.label;
        item.addEventListener('click', () => {
          current = opt.value;
          renderTrigger();
          closePanel();
          if (onChange) onChange(current);
          root.dispatchEvent(new CustomEvent('change', { detail: current }));
        });
        list.appendChild(item);
      }
      if (matches.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'xselect-empty';
        empty.textContent = 'Aucun résultat';
        list.appendChild(empty);
      }
    }
    renderList('');
    if (search) search.addEventListener('input', () => renderList(search.value));

    document.body.appendChild(panel);
    const rect = button.getBoundingClientRect();
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.bottom + 4}px`;
    panel.style.width = `${Math.max(rect.width, 220)}px`;
    // Corrige un débordement bas d'écran en ouvrant vers le haut plutôt.
    requestAnimationFrame(() => {
      const panelRect = panel.getBoundingClientRect();
      if (panelRect.bottom > window.innerHeight) {
        panel.style.top = `${Math.max(8, rect.top - panelRect.height - 4)}px`;
      }
    });

    root.classList.add('open');
    if (search) search.focus();

    const onOutside = (e) => {
      if (!panel.contains(e.target) && e.target !== button) closePanel();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') closePanel();
    };
    setTimeout(() => {
      document.addEventListener('click', onOutside);
      document.addEventListener('keydown', onKey);
    }, 0);

    closePanel = () => {
      panel.remove();
      root.classList.remove('open');
      document.removeEventListener('click', onOutside);
      document.removeEventListener('keydown', onKey);
      closePanel = null;
    };
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (closePanel) closePanel();
    else openPanel();
  });

  Object.defineProperty(root, 'value', {
    get() {
      return current;
    },
    set(v) {
      current = v;
      renderTrigger();
    },
  });

  return root;
}
