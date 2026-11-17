import { readFileSync } from 'node:fs';
import { hostCall, servePlugin } from './host-client.mjs';
const manifest = JSON.parse(readFileSync(new URL('./octipus-plugin.json', import.meta.url), 'utf8'));
servePlugin(manifest, {
  connection_check: { run: async (_args, meta) => {
    const connection = process.env.OCTIPUS_SETTING_CONNECTION;
    const path = process.env.OCTIPUS_SETTING_HEALTH_PATH;
    if (!connection || !path) return { ok: false, message: 'Choose a service connection and its health endpoint in plugin setup.' };
    const result = await hostCall(meta, 'connections:read', 'POST', '/connections/get', { connection, path });
    return { ok: result.ok === true, message: result.ok ? 'The service connection is working.' : `The service returned HTTP ${result.status}.` };
  } },
});
