import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { app } from 'electron';

/**
 * Identifiant de machine persistant (généré une fois, stocké localement) + nom lisible — affiché
 * aux autres membres de la team via `presence:acquired` (cf. plan : "qui utilise quoi, sur
 * quelle machine"). Un simple `os.hostname()` seul ne suffit pas comme identifiant stable : deux
 * machines peuvent partager le même nom d'hôte (ex. "DESKTOP-XXXX" par défaut sous Windows) — le
 * nom reste pour l'AFFICHAGE, l'UUID sert à distinguer les machines si besoin plus tard.
 */
let cachedMachineId: string | null = null;

function machineIdFilePath(): string {
  return path.join(app.getPath('userData'), 'machine-id.json');
}

export function getMachineId(): string {
  if (cachedMachineId) return cachedMachineId;
  const filePath = machineIdFilePath();
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { id?: string };
      if (typeof parsed.id === 'string' && parsed.id) {
        cachedMachineId = parsed.id;
        return cachedMachineId;
      }
    } catch {
      // fichier corrompu : on en régénère un, pas bloquant.
    }
  }
  const id = randomUUID();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ id }));
  cachedMachineId = id;
  return id;
}

/** Label lisible envoyé au serveur (présence) — pas besoin d'unicité stricte, juste d'être parlant. */
export function getMachineLabel(): string {
  return `${os.hostname()} (${process.platform})`;
}
