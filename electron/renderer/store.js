// Store pub-sub minimal, sans dépendance (cf. plan §UI) : la vraie complexité de ce renderer
// n'est pas le rendu (une grille de quelques cartes reste simple à diffuser à la main) mais la
// SYNCHRONISATION D'ÉTAT (auth, team active, catalogue live, présence live) — alimenté par les
// push WebSocket relayés via `window.smonster.events.on(...)`, plus besoin du
// `setInterval(refresh, ...)` de l'ancien dashboard.
function createStore(initial) {
  let state = initial;
  const subscribers = new Set();
  return {
    get() {
      return state;
    },
    set(patch) {
      state = typeof patch === 'function' ? patch(state) : { ...state, ...patch };
      for (const fn of subscribers) fn(state);
    },
    subscribe(fn) {
      subscribers.add(fn);
      fn(state); // appel immédiat avec l'état courant, pas besoin d'attendre le prochain set()
      return () => subscribers.delete(fn);
    },
  };
}
