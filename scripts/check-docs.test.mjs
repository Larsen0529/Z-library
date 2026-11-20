import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('shared worker role prose is allowed; worker home paths remain forbidden', t => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'docs-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(new URL('check-docs.mjs', import.meta.url), path.join(root, 'scripts/check-docs.mjs'));
  assert.equal(spawnSync('git', ['init', root]).status, 0);
  const doc = path.join(root, 'README.md');
  fs.writeFileSync(doc, 'An agent handles the request.\n');
  assert.equal(spawnSync(process.execPath, ['scripts/check-docs.mjs'], { cwd: root }).status, 0);
  const fixturePath = '/' + ['home', 'agent', 'private.txt'].join('/');
  fs.writeFileSync(doc, `Private file: ${fixturePath}\n`);
  assert.equal(spawnSync(process.execPath, ['scripts/check-docs.mjs'], { cwd: root }).status, 1);
});
