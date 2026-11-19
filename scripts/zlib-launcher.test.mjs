import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./zlib.sh', import.meta.url));

test('launcher resolves the persisted CLI and preserves arguments, cwd and status',
  { skip: process.platform === 'win32' }, () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'zlib-launcher-')));
    try {
      const repo = path.join(root, 'checkout with spaces');
      const scripts = path.join(repo, 'scripts');
      const binary = path.join(root, '.zlib-tools/codex-install-home/.local/bin/zlib');
      mkdirSync(scripts, { recursive: true });
      mkdirSync(path.dirname(binary), { recursive: true });
      copyFileSync(source, path.join(scripts, 'zlib.sh'));
      const run = (cwd, launcher, args = []) => spawnSync('/bin/sh', [launcher, ...args], {
        cwd, encoding: 'utf8',
      });

      // Missing binaries must fail, even if an unrelated zlib is on PATH.
      let result = run(root, './checkout with spaces/scripts/zlib.sh', ['version']);
      assert.equal(result.status, 127);
      assert.match(result.stderr, /persisted CLI is missing/);
      assert.ok(result.stderr.includes(binary));

      writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$#" "$@"\nexit 23\n', { mode: 0o644 });
      result = run(repo, './scripts/zlib.sh');
      assert.equal(result.status, 126);
      assert.match(result.stderr, /not executable/);

      chmodSync(binary, 0o755);
      for (const [cwd, launcher] of [
        [root, './checkout with spaces/scripts/zlib.sh'],
        [repo, './scripts/zlib.sh'],
        [realpathSync(tmpdir()), path.join(scripts, 'zlib.sh')],
      ]) {
        result = run(cwd, launcher, ['meta', 'a book.epub', '', '$(false);*']);
        assert.equal(result.status, 23, result.stderr);
        assert.deepEqual(result.stdout.trimEnd().split('\n'),
          [cwd, '4', 'meta', 'a book.epub', '', '$(false);*']);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
