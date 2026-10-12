import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Azure Functions v4 registers a route only when its module is imported, and
 * `src/index.ts` is the only thing the runtime loads. A function file nobody
 * imports deploys, builds and type-checks cleanly, and answers 404 in
 * production. `/api/quota` was one import away from exactly that.
 */
const src = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));

test('every function file is imported by the entry point', () => {
  const index = fs.readFileSync(path.join(src, 'index.ts'), 'utf8');
  const files = fs.readdirSync(path.join(src, 'functions')).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const mod = `./functions/${f.replace(/\.ts$/, '')}`;
    assert.ok(index.includes(`import '${mod}';`), `${mod} is not imported by src/index.ts, so its route would 404`);
  }
});
