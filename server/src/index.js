import { openDatabase } from './db/database.js';
import { createServer } from './http.js';
import { ensureLocalDeviceProvisioned } from './services/devices.js';
import { trackerMode } from './config.js';

const port = Number(process.env.PORT || 8787);
const db = openDatabase();
const provisioned = ensureLocalDeviceProvisioned(db);
if (provisioned) {
  console.log(`[tracker] mode=${trackerMode()} provisioned local device ${provisioned.device_id}`);
} else {
  console.log(`[tracker] mode=${trackerMode()}`);
}
const app = createServer(db, { port });

await app.start();

process.on('SIGINT', async () => {
  await app.stop();
  db.close();
  process.exit(0);
});
