import { DriverBuilder } from './driverBuilder';
import type { BuiltDriver, DriverBuilderOptions } from './driverBuilder';

export interface DriverPoolOptions {
  /**
   * Fabrique appelée à chaque nouveau slot du pool (pas une seule fois pour tout le pool) :
   * permet de varier les devices/proxies/locales entre profils plutôt que d'avoir un pool de
   * clones identiques.
   */
  factory: () => DriverBuilderOptions;
  /** Nombre max de profils vivants (construits ou en cours de construction) simultanément. */
  maxConcurrent: number;
  /**
   * Nombre d'utilisations (cycles acquire/release) autorisées pour un même profil avant qu'il
   * soit fermé et remplacé au prochain acquire(). `undefined` (défaut) = pas de limite, un
   * profil vit tant qu'il reste connecté.
   */
  maxUsesPerProfile?: number;
  /**
   * Délai max (ms) qu'un acquire() peut passer à attendre qu'un slot se libère quand le pool
   * est plein. `undefined` (défaut) = attente indéfinie.
   */
  acquireTimeoutMs?: number;
}

interface PoolEntry {
  driver: BuiltDriver;
  uses: number;
}

/**
 * Pool de profils Playwright construits via `DriverBuilder`, avec concurrence bornée et
 * réutilisation de profil entre tâches.
 *
 * Sûr à utiliser en parallèle : `DriverBuilder.build()` ne touche aucun état mutable partagé
 * entre instances/appels (chaque appel a son propre `profileDir` via `randomUUID()`), et les
 * plugins stealth globaux (`chromium.use`/`webkit.use` dans driverBuilder.ts) n'ont plus
 * d'évasion à état partagé problématique sous concurrence depuis l'exclusion de
 * `user-agent-override` — voir les commentaires à ce sujet dans driverBuilder.ts.
 *
 * Modèle acquire/release façon pool de connexions :
 * - `acquire()` rend un profil idle réutilisable s'il y en a un de sain, en construit un
 *   nouveau s'il reste de la place, ou attend qu'une place se libère sinon.
 * - `release()` remet le profil dans le pool (avec une page fraîche pour la prochaine tâche,
 *   mais le même contexte persistant — donc les cookies/localStorage survivent, ce qui est
 *   tout l'intérêt de la réutilisation) ou le ferme et le décompte du pool si `discard: true`,
 *   s'il a crashé, ou s'il a atteint `maxUsesPerProfile`.
 */
export class DriverPool {
  private readonly factory: () => DriverBuilderOptions;
  private readonly maxConcurrent: number;
  private readonly maxUsesPerProfile?: number;
  private readonly acquireTimeoutMs?: number;

  private readonly idle: PoolEntry[] = [];
  private readonly leased = new Set<BuiltDriver>();
  private readonly entryByDriver = new Map<BuiltDriver, PoolEntry>();
  private liveCount = 0; // idle.length + leased.size, y compris les slots en cours de build()
  private readonly waiters: Array<() => void> = [];
  private draining = false;

  constructor(opts: DriverPoolOptions) {
    if (opts.maxConcurrent < 1) {
      throw new Error(`maxConcurrent doit être >= 1 (reçu: ${opts.maxConcurrent}).`);
    }
    this.factory = opts.factory;
    this.maxConcurrent = opts.maxConcurrent;
    this.maxUsesPerProfile = opts.maxUsesPerProfile;
    this.acquireTimeoutMs = opts.acquireTimeoutMs;
  }

  get size(): number {
    return this.liveCount;
  }

  get idleCount(): number {
    return this.idle.length;
  }

  get leasedCount(): number {
    return this.leased.size;
  }

  async acquire(): Promise<BuiltDriver> {
    if (this.draining) {
      throw new Error("DriverPool en cours de fermeture (drain) : impossible d'acquérir un profil.");
    }

    // 1) Un profil idle est disponible : on le réutilise s'il est toujours sain, sinon on
    // le décompte et on continue à chercher/construire.
    while (this.idle.length > 0) {
      const entry = this.idle.shift()!;
      if (!entry.driver.browser.isConnected()) {
        this.entryByDriver.delete(entry.driver);
        this.liveCount--;
        continue;
      }
      return this.leaseWithFreshPage(entry);
    }

    // 2) De la place pour en construire un nouveau.
    if (this.liveCount < this.maxConcurrent) {
      this.liveCount++;
      try {
        const builder = new DriverBuilder(this.factory());
        const driver = await builder.build();
        const entry: PoolEntry = { driver, uses: 0 };
        this.entryByDriver.set(driver, entry);
        this.leased.add(driver);
        return driver;
      } catch (err) {
        this.liveCount--;
        throw err;
      }
    }

    // 3) Pool plein : on attend qu'une place se libère (release() ou évacuation d'un profil
    // mort constaté ci-dessus), puis on retente au début — un autre appelant a pu être plus
    // rapide entre-temps, ou le slot libéré peut avoir été repris par un waiter concurrent.
    await this.waitForSlot();
    return this.acquire();
  }

  /**
   * Sort une page fraîche du contexte réutilisé plutôt que de rendre la page de la tâche
   * précédente telle quelle (URL/état DOM résiduels) : le profil (cookies, localStorage,
   * stockage disque) est conservé, seule la page l'est pas.
   */
  private async leaseWithFreshPage(entry: PoolEntry): Promise<BuiltDriver> {
    const previous = entry.driver;
    const page = await previous.context.newPage();
    await previous.page.close().catch(() => {});
    const driver: BuiltDriver = { ...previous, page };

    entry.driver = driver;
    this.entryByDriver.delete(previous);
    this.entryByDriver.set(driver, entry);
    this.leased.add(driver);
    return driver;
  }

  async release(driver: BuiltDriver, opts: { discard?: boolean } = {}): Promise<void> {
    // `driver` inconnu de ce pool, ou déjà release (double release) : no-op défensif plutôt
    // que de fermer un contexte qu'on ne possède plus ou de dupliquer une entrée idle.
    if (!this.leased.has(driver)) {
      return;
    }
    const entry = this.entryByDriver.get(driver)!;
    this.leased.delete(driver);
    entry.uses++;

    const shouldDiscard =
      this.draining ||
      opts.discard === true ||
      !driver.browser.isConnected() ||
      (this.maxUsesPerProfile !== undefined && entry.uses >= this.maxUsesPerProfile);

    if (shouldDiscard) {
      this.entryByDriver.delete(driver);
      this.liveCount--;
      await DriverBuilder.quit(driver.context).catch(() => {});
    } else {
      this.idle.push(entry);
    }

    this.wakeOneWaiter();
  }

  /**
   * Ferme immédiatement tous les profils idle et n'accepte plus de nouveaux acquire(). Les
   * profils encore en cours d'utilisation (`leased`) sont fermés dès leur prochain release()
   * (cf. `this.draining` dans `release()`) plutôt que coupés sous le pied de l'appelant.
   */
  async drain(): Promise<void> {
    this.draining = true;

    const idleEntries = this.idle.splice(0, this.idle.length);
    await Promise.all(
      idleEntries.map((entry) => {
        this.entryByDriver.delete(entry.driver);
        this.liveCount--;
        return DriverBuilder.quit(entry.driver.context).catch(() => {});
      })
    );

    // Réveille les acquire() en attente pour qu'ils échouent proprement (cf. le check
    // `this.draining` en tête d'acquire()) plutôt que de rester bloqués indéfiniment.
    while (this.waiters.length > 0) {
      this.waiters.shift()!();
    }
  }

  private wakeOneWaiter(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
    }
  }

  private waitForSlot(): Promise<void> {
    if (this.acquireTimeoutMs === undefined) {
      return new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(onSlot);
        if (idx !== -1) {
          this.waiters.splice(idx, 1);
        }
        reject(new Error(`DriverPool: timeout (${this.acquireTimeoutMs}ms) en attente d'un profil disponible.`));
      }, this.acquireTimeoutMs);
      const onSlot = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(onSlot);
    });
  }
}
