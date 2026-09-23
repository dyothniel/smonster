import type { ProxyConfig } from './driverBuilder';

export interface ProxyRotatorOptions {
  proxies: ProxyConfig[];
  /** Stratégie de sélection parmi les proxies disponibles. Défaut: 'round-robin'. */
  strategy?: 'round-robin' | 'random';
  /** Échecs consécutifs avant qu'un proxy soit exclu temporairement. Défaut: 3. */
  maxConsecutiveFailures?: number;
  /** Durée (ms) d'exclusion d'un proxy après `maxConsecutiveFailures`. Défaut: 5 minutes. */
  cooldownMs?: number;
}

interface ProxyState {
  proxy: ProxyConfig;
  consecutiveFailures: number;
  excludedUntil: number | null;
}

/**
 * Sélectionne un proxy parmi plusieurs, avec exclusion temporaire de ceux qui échouent trop
 * souvent. Pensé pour être branché sur `DriverBuilder` (cf. `DriverBuilderOptions.proxyRotator`) :
 * chaque tentative de la boucle de retry de `build()` demande un proxy via `next()` et rapporte
 * le résultat via `reportSuccess`/`reportFailure`, donc un proxy mort est automatiquement
 * écarté au profit d'un autre dès la tentative suivante.
 */
export class ProxyRotator {
  private readonly proxies: ProxyState[];
  private readonly strategy: 'round-robin' | 'random';
  private readonly maxConsecutiveFailures: number;
  private readonly cooldownMs: number;
  private roundRobinIndex = 0;
  // Associe une clé arbitraire (fournie par l'appelant, ex. un id de slot de pool) au proxy
  // qui lui a été assigné, pour garder la même IP sur la durée de vie de cette clé plutôt que
  // de changer de proxy à chaque appel — une IP qui change en cours de session est un signal
  // de détection bien plus grave qu'une répartition parfaitement uniforme entre proxies.
  private readonly stickyAssignments = new Map<string, ProxyConfig>();

  constructor(opts: ProxyRotatorOptions) {
    if (opts.proxies.length === 0) {
      throw new Error('ProxyRotator: au moins un proxy est requis.');
    }
    this.proxies = opts.proxies.map((proxy) => ({ proxy, consecutiveFailures: 0, excludedUntil: null }));
    this.strategy = opts.strategy ?? 'round-robin';
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 5 * 60_000;
  }

  get total(): number {
    return this.proxies.length;
  }

  get availableCount(): number {
    return this.availableStates().length;
  }

  /**
   * Retourne un proxy disponible. Si `stickyKey` est fourni et a déjà un proxy assigné qui
   * n'est pas exclu, ce même proxy est retourné ; sinon un proxy est choisi selon `strategy`
   * et (si `stickyKey` est fourni) associé à cette clé pour les prochains appels.
   *
   * @throws si tous les proxies sont actuellement exclus (cooldown après échecs répétés).
   */
  next(stickyKey?: string): ProxyConfig {
    if (stickyKey !== undefined) {
      const sticky = this.stickyAssignments.get(stickyKey);
      if (sticky && this.isAvailable(sticky)) {
        return sticky;
      }
    }

    const available = this.availableStates();
    if (available.length === 0) {
      throw new Error('ProxyRotator: aucun proxy disponible (tous exclus temporairement après échecs répétés).');
    }

    const chosen =
      this.strategy === 'random'
        ? available[Math.floor(Math.random() * available.length)]
        : this.pickRoundRobin(available);

    if (stickyKey !== undefined) {
      this.stickyAssignments.set(stickyKey, chosen.proxy);
    }
    return chosen.proxy;
  }

  /** Remet à zéro le compteur d'échecs consécutifs d'un proxy après une utilisation réussie. */
  reportSuccess(proxy: ProxyConfig): void {
    const state = this.findState(proxy);
    if (state) {
      state.consecutiveFailures = 0;
    }
  }

  /**
   * Incrémente le compteur d'échecs d'un proxy ; au-delà de `maxConsecutiveFailures`, il est
   * exclu pour `cooldownMs`. Attribution volontairement grossière : n'importe quel échec
   * pendant une tentative utilisant ce proxy compte contre lui (IP bloquée, latence, timeout...)
   * plutôt que de tenter de distinguer précisément la cause.
   */
  reportFailure(proxy: ProxyConfig): void {
    const state = this.findState(proxy);
    if (!state) {
      return;
    }
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= this.maxConsecutiveFailures) {
      state.excludedUntil = Date.now() + this.cooldownMs;
    }
  }

  private isAvailable(proxy: ProxyConfig): boolean {
    const state = this.findState(proxy);
    return !!state && (state.excludedUntil === null || state.excludedUntil <= Date.now());
  }

  private availableStates(): ProxyState[] {
    const now = Date.now();
    // Réintègre automatiquement les proxies dont le cooldown est passé.
    for (const state of this.proxies) {
      if (state.excludedUntil !== null && state.excludedUntil <= now) {
        state.excludedUntil = null;
        state.consecutiveFailures = 0;
      }
    }
    return this.proxies.filter((s) => s.excludedUntil === null);
  }

  private pickRoundRobin(available: ProxyState[]): ProxyState {
    // Tourne sur l'ensemble complet (pas juste les dispos) pour garder un ordre stable même
    // quand des proxies entrent/sortent d'exclusion ; on saute simplement les indisponibles.
    for (let i = 0; i < this.proxies.length; i++) {
      const idx = (this.roundRobinIndex + i) % this.proxies.length;
      const state = this.proxies[idx];
      if (available.includes(state)) {
        this.roundRobinIndex = (idx + 1) % this.proxies.length;
        return state;
      }
    }
    /* istanbul ignore next -- available est non-vide et ⊆ this.proxies, donc inatteignable */
    return available[0];
  }

  private findState(proxy: ProxyConfig): ProxyState | undefined {
    return this.proxies.find((s) => s.proxy === proxy || s.proxy.server === proxy.server);
  }
}
