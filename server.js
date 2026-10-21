// Starts OUTTANS HQ. Railway runs this with "npm start".

import { createApp } from './platform/app.js';
import { resolveDataDir } from './platform/storage.js';
import tools from './tools/index.js';

const dataDir = resolveDataDir();
const app = createApp({ dataDir, tools });
const port = Number(process.env.PORT) || 8080;

app.listen(port, () => {
  console.log(`OUTTANS HQ is running on port ${port}. Data folder: ${dataDir}`);
  if (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR) {
    console.warn('WARNING: No Railway volume attached. Accounts and tool data will be lost on every redeploy. See README.');
  }
  app.locals.startTools();
});
