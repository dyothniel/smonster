import { Server as SocketIOServer } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { verifyAccessToken } from '../auth/jwt';
import type { AccessTokenPayload } from '../auth/jwt';
import { PresenceTracker } from './presence';

function teamRoom(teamId: string): string {
  return `team:${teamId}`;
}

interface AcquirePayload {
  teamId: string;
  profileId: string;
  machineLabel?: string;
}
interface ReleasePayload {
  teamId: string;
  profileId: string;
}
type Ack = (res: { ok: boolean; error?: string }) => void;

function hasAccess(user: AccessTokenPayload, teamId: string): boolean {
  return user.isSuperAdmin || user.teams.some((t) => t.teamId === teamId);
}
function isTeamAdmin(user: AccessTokenPayload, teamId: string): boolean {
  return user.isSuperAdmin || user.teams.some((t) => t.teamId === teamId && t.role === 'TEAM_ADMIN');
}

/**
 * Socket.IO plutôt que `ws` brut (cf. plan) : le `disconnect` automatique (heartbeat
 * `pingInterval`/`pingTimeout`) résout directement "libérer le verrou si le client crash" sans
 * rien coder à la main — c'est tout l'intérêt par rapport à un websocket nu, pas une préférence
 * de style.
 */
export interface AttachWebSocketOptions {
  /** Surchargeable en test pour ne pas attendre ~30s réelles qu'un disconnect soit détecté. */
  pingInterval?: number;
  pingTimeout?: number;
}

export function attachWebSocket(httpServer: HttpServer, presence: PresenceTracker, opts: AttachWebSocketOptions = {}): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    // ~10s/20s par défaut -> un crash/sommeil machine libère son verrou sous ~30s dans le pire
    // cas (cf. plan, compromis assumé — filet de sécurité : l'action "forcer la libération" du
    // TEAM_ADMIN).
    pingInterval: opts.pingInterval ?? 10_000,
    pingTimeout: opts.pingTimeout ?? 20_000,
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const payload = typeof token === 'string' ? verifyAccessToken(token) : null;
    if (!payload) {
      next(new Error('unauthorized'));
      return;
    }
    socket.data.user = payload;
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user as AccessTokenPayload;
    for (const t of user.teams) socket.join(teamRoom(t.teamId));

    socket.on('profile:acquire', (payload: AcquirePayload, ack: Ack) => {
      if (!hasAccess(user, payload.teamId)) {
        ack({ ok: false, error: 'forbidden' });
        return;
      }
      const acquired = presence.acquire(payload.profileId, {
        teamId: payload.teamId,
        userId: user.sub,
        socketId: socket.id,
        machineLabel: payload.machineLabel ?? null,
        acquiredAt: new Date().toISOString(),
      });
      if (acquired) {
        io.to(teamRoom(payload.teamId)).emit('presence:acquired', {
          profileId: payload.profileId,
          userId: user.sub,
          displayName: user.displayName,
          machineLabel: payload.machineLabel ?? null,
        });
      }
      ack({ ok: acquired, error: acquired ? undefined : 'already_in_use' });
    });

    // Volontairement PAS appelé automatiquement avant l'upload d'état côté client — c'est
    // `profileManager.stop()` (phase C) qui appelle ceci APRÈS que l'upload soit confirmé (cf.
    // doc du plan : "le verrou reste tenu pendant l'upload").
    socket.on('profile:release', (payload: ReleasePayload, ack?: Ack) => {
      presence.release(payload.profileId, socket.id);
      io.to(teamRoom(payload.teamId)).emit('presence:released', { profileId: payload.profileId, forced: false });
      ack?.({ ok: true });
    });

    socket.on('profile:forceRelease', (payload: ReleasePayload, ack?: Ack) => {
      if (!isTeamAdmin(user, payload.teamId)) {
        ack?.({ ok: false, error: 'forbidden' });
        return;
      }
      presence.forceRelease(payload.profileId);
      io.to(teamRoom(payload.teamId)).emit('presence:released', { profileId: payload.profileId, forced: true });
      ack?.({ ok: true });
    });

    socket.on('disconnect', () => {
      const released = presence.releaseAllForSocket(socket.id);
      for (const { profileId, entry } of released) {
        io.to(teamRoom(entry.teamId)).emit('presence:released', { profileId, forced: false });
      }
    });
  });

  return io;
}
