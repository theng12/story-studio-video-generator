import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));


test('Gateway mode is unusable without the loopback host permissions', () => {
  // Gateway mode fetches http://127.0.0.1:8787; a host without a port matches every port.
  // Without these three, every connect fails with "Failed to fetch".
  const modeSource = readFileSync(path.join(root, 'src/lib/config.js'), 'utf8');
  if (!modeSource.includes("'gateway'")) return;
  for (const host of ['http://127.0.0.1/*', 'http://localhost/*', 'http://[::1]/*']) {
    assert.ok(manifest.host_permissions.includes(host), `${host} is declared`);
  }
});
