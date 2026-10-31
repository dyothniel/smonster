/**
 * Verrou "profil en cours d'usage" — EN MÉMOIRE, pas en base (cf. plan : évite une écriture DB à
 * chaque lancement et des lignes périmées après un crash). Un seul process serveur le possède ;
 * si le process redémarre, tous les verrous sont perdus — c'est voulu, un redémarrage serveur
 * coupe de toute façon les connexions WebSocket de tout le monde, donc plus personne ne tenait
 * légitimement un verrou à ce moment-là.
 */
export interface PresenceEntry {
  teamId: string;
  userId: string;
  socketId: string;
  machineLabel: string | null;
  acquiredAt: string;
}

export class PresenceTracker {
  private readonly byProfile = new Map<string, PresenceEntry>();
  // Index inverse : retrouver tous les profils tenus par un socket donné, pour tout libérer
  // d'un coup à la déconnexion sans parcourir `byProfile` en entier.
  private readonly bySocket = new Map<string, Set<string>>();

  get(profileId: string): PresenceEntry | undefined {
    return this.byProfile.get(profileId);
  }

  /** `true` si le verrou a été acquis, `false` si déjà tenu par quelqu'un d'autre. */
  acquire(profileId: string, entry: PresenceEntry): boolean {
    const existing = this.byProfile.get(profileId);
    if (existing && existing.socketId !== entry.socketId) {
      return false;
    }
    this.byProfile.set(profileId, entry);
    let forSocket = this.bySocket.get(entry.socketId);
    if (!forSocket) {
      forSocket = new Set();
      this.bySocket.set(entry.socketId, forSocket);
    }
    forSocket.add(profileId);
    return true;
  }

  /** No-op si ce socket ne tient pas ce verrou — jamais d'exception sur un release redondant. */
  release(profileId: string, socketId: string): void {
    const existing = this.byProfile.get(profileId);
    if (!existing || existing.socketId !== socketId) return;
    this.byProfile.delete(profileId);
    this.bySocket.get(socketId)?.delete(profileId);
  }

  /**
   * Appelé au `disconnect` du socket (heartbeat Socket.IO) — libère tout ce qu'il tenait.
   * Renvoie `{profileId, entry}` pour chaque verrou libéré : l'appelant a besoin du `profileId`
   * ET de `entry.teamId` pour savoir QUOI annoncer et dans QUELLE room (`entry` seul perd
   * l'association, vu que `byProfile` est justement indexé PAR profileId).
   */
  releaseAllForSocket(socketId: string): { profileId: string; entry: PresenceEntry }[] {
    const held = this.bySocket.get(socketId);
    if (!held) return [];
    const released: { profileId: string; entry: PresenceEntry }[] = [];
    for (const profileId of held) {
      const entry = this.byProfile.get(profileId);
      if (entry) released.push({ profileId, entry });
      this.byProfile.delete(profileId);
    }
    this.bySocket.delete(socketId);
    return released;
  }

  /** `TEAM_ADMIN` force-release (filet de sécurité, cf. plan) — libère peu importe qui le tenait. */
  forceRelease(profileId: string): void {
    const existing = this.byProfile.get(profileId);
    if (!existing) return;
    this.byProfile.delete(profileId);
    this.bySocket.get(existing.socketId)?.delete(profileId);
  }

  /** Pour peupler le champ `inUseBy` d'un `GET .../profiles` (cf. profilesRouter.ts). */
  snapshotForTeam(profileIds: string[]): Record<string, PresenceEntry> {
    const result: Record<string, PresenceEntry> = {};
    for (const id of profileIds) {
      const entry = this.byProfile.get(id);
      if (entry) result[id] = entry;
    }
    return result;
  }
}
