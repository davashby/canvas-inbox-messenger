import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory } from '../server/platform.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const marketplaceRoot = join(dataDirectory(), 'local-marketplace');
const manifestPath = join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json');
await mkdir(dirname(manifestPath), { recursive: true });
const installedSource = join(marketplaceRoot, 'canvas-inbox-plugin');
await mkdir(installedSource, { recursive: true });
for (const component of ['plugin.json', 'mcp.json', 'README.md', 'scripts', 'server', 'skills']) {
  await cp(join(pluginRoot, component), join(installedSource, component), { recursive: true, force: true });
}
await writeFile(manifestPath, JSON.stringify({
  name: 'canvas-inbox-local',
  interface: { displayName: 'Canvas Inbox local' },
  plugins: [{
    name: 'canvas-inbox-plugin', source: { source: 'local', path: './canvas-inbox-plugin' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Education'
  }]
}, null, 2));
console.log(marketplaceRoot);
