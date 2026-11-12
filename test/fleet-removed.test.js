import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Fleet Hub is fully removed', async () => {
  const sources = await Promise.all(['../src/options/options.html', '../src/lib/config.js', '../src/background.js'].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  for (const source of sources) assert.doesNotMatch(source, /fleet/i);
});
