import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('a fixed key keeps the extension id stable across versioned folders', () => {
  // Without a key Chrome derives a new id from the folder path every release, so a seeded
  // extension id and its storage are orphaned. This pins the id.
  assert.ok(manifest.key, 'the manifest carries a fixed key');
  const der = Buffer.from(manifest.key, 'base64');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  const id = [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('');
  assert.equal(id, 'jjmjhbmfklljgcfggmgmbodbhlfbmfof');
});

test('the Gateway pane shows the Relay-owned connection honestly', () => {
  const popup = readFileSync(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
  assert.match(popup, /Connected through Relay/, 'the seeded state is named');
  assert.match(popup, /gatewayRelayMachineId/, 'the Relay marker is read');
  assert.match(popup, /gatewayReadiness/, 'the shared readiness object is read');
  assert.match(popup, /readiness\.reason/, 'a blocked readiness shows its reason');
});
