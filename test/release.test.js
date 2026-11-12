import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
test('manifest version matches the newest release notes and every declared file exists', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const notes = await readFile(resolve(root, 'CHANGELOG.md'), 'utf8');
  assert.equal(manifest.version, notes.match(/^## (\d+\.\d+\.\d+)/m)?.[1]);
  const paths = [manifest.background.service_worker, manifest.side_panel.default_path, manifest.options_page, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  await Promise.all([...new Set(paths)].map((path) => access(resolve(root, path))));
});
test('release notes describe signed Flow inventory and ambiguity recovery', async () => {
  const [readme, changelog] = await Promise.all([readFile(resolve(root, 'README.md'), 'utf8'), readFile(resolve(root, 'CHANGELOG.md'), 'utf8')]);
  assert.match(readme, /signed Flow website session/i); assert.match(readme, /live[\s\S]*fallback/i);
  assert.match(changelog, /Earlier releases are in `git log`/); assert.match(readme, /fresh-image.*review/i);
});
