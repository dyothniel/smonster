import * as path from 'path';
import * as http from 'http';
import { openDatabase } from './db';
import { UserRepository } from './db/users';
import { TeamRepository } from './db/teams';
import { ProxyRepository } from './db/proxies';
import { ProfileRepository } from './db/profiles';
import { RefreshTokenRepository } from './db/refreshTokens';
import { EmailCodeRepository } from './db/emailCodes';
import { ProfileStateStore } from './profileState';
import { PresenceTracker } from './ws/presence';
import { createApp } from './httpServer';
import { attachWebSocket } from './ws';

const PORT = Number(process.env.PORT ?? 3002); // 3002 réservé pour ce projet, cf. VPS_INFRA.md
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '..', '..', 'data');

const db = openDatabase(path.join(DATA_DIR, 'smonster.sqlite'));
const deps = {
  users: new UserRepository(db),
  teams: new TeamRepository(db),
  proxies: new ProxyRepository(db),
  profiles: new ProfileRepository(db),
  refreshTokens: new RefreshTokenRepository(db),
  emailCodes: new EmailCodeRepository(db),
  state: new ProfileStateStore(path.join(DATA_DIR, 'profile-state')),
  presence: new PresenceTracker(),
  dataDir: DATA_DIR,
};

const app = createApp(deps);
const httpServer = http.createServer(app); // Socket.IO a besoin du http.Server brut, pas juste de l'app Express
attachWebSocket(httpServer, deps.presence);

httpServer.listen(PORT, () => {
  console.log(`Backend smonster sur http://localhost:${PORT} (données: ${DATA_DIR})`);
});
