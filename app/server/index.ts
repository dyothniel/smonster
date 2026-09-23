import * as path from 'path';
import { ProfileStore } from '../profileStore';
import { ProfileManager } from '../profileManager';
import { createApp } from './httpServer';

const PORT = Number(process.env.PORT ?? 3002); // 3002 réservé pour ce projet, cf. VPS_INFRA.md
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '..', '..', 'data');

const store = new ProfileStore(DATA_DIR);
const manager = new ProfileManager(store);
const app = createApp(manager);

app.listen(PORT, () => {
  console.log(`Dashboard smonster sur http://localhost:${PORT} (données: ${DATA_DIR})`);
});
