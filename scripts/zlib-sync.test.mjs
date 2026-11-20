import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { synchronize } from './zlib-sync.mjs';

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sync-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'origin.git'), author = path.join(root, 'author'), local = path.join(root, 'local');
  git(root, 'init', '--bare', remote); git(root, 'init', '-b', 'main', author);
  fs.mkdirSync(path.join(author, 'scripts'));
  for (const name of ['zlib-sync.mjs', 'zlib-workflow.mjs']) fs.copyFileSync(new URL(name, import.meta.url), path.join(author, 'scripts', name));
  fs.writeFileSync(path.join(author, 'scripts/zlib-workflow-core.mjs'), 'import fs from "node:fs"; export async function main(){fs.writeSync(1,"OLD\\n")}');
  git(author, 'add', '.'); git(author, 'commit', '-m', 'fixture');
  git(author, 'remote', 'add', 'origin', remote); git(author, 'push', 'origin', 'main');
  git(root, 'clone', '-b', 'main', remote, local);
  const initial = git(local, 'rev-parse', 'HEAD');
  const advance = () => {
    fs.writeFileSync(path.join(author, 'scripts/zlib-workflow-core.mjs'), 'import fs from "node:fs"; export async function main(args){fs.writeSync(1,JSON.stringify({version:"NEW",args})+"\\n")}');
    git(author, 'add', '.'); git(author, 'commit', '-m', 'advance'); git(author, 'push', 'origin', 'main');
    return git(author, 'rev-parse', 'HEAD');
  };
  return { root, local, initial, advance };
}
const node = (cwd, args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }));
});
for (const detached of [false, true]) test(`fast-forward and fresh process, detached=${detached}`, async t => {
  const f = fixture(t);
  if (detached) git(f.local, 'checkout', '--detach');
  const latest = f.advance();
  const r = await node(f.local, ['scripts/zlib-workflow.mjs', 'search', 'fixture']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout, JSON.stringify(r));
  assert.deepEqual(JSON.parse(r.stdout), { version: 'NEW', args: ['search', 'fixture'] });
  assert.equal(git(f.local, 'rev-parse', 'HEAD'), latest);
  assert.equal(git(f.local, 'status', '--porcelain'), '');
  assert.equal(synchronize(f.local), latest);
});
test('dirty tracked and untracked worktrees never advance', t => {
  const f = fixture(t); f.advance();
  for (const name of ['scripts/zlib-workflow-core.mjs', 'untracked']) {
    fs.appendFileSync(path.join(f.local, name), 'changed');
    assert.throws(() => synchronize(f.local), { code: 'git_worktree_dirty' });
    assert.equal(git(f.local, 'rev-parse', 'HEAD'), f.initial);
    if (name === 'untracked') fs.unlinkSync(path.join(f.local, name));
    else git(f.local, 'restore', name);
  }
});
test('divergence and local-only commits stop without overwriting', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.local, 'local'), 'fixture'); git(f.local, 'add', '.'); git(f.local, 'commit', '-m', 'local');
  const head = git(f.local, 'rev-parse', 'HEAD');
  assert.throws(() => synchronize(f.local), { code: 'git_not_fast_forward' });
  f.advance();
  assert.throws(() => synchronize(f.local), { code: 'git_not_fast_forward' });
  assert.equal(git(f.local, 'rev-parse', 'HEAD'), head);
});
test('unreachable remote fails closed without running workflow', async t => {
  const f = fixture(t);
  git(f.local, 'remote', 'set-url', 'origin', path.join(f.root, 'missing.git'));
  const r = await node(f.local, ['scripts/zlib-workflow.mjs', 'search', 'fixture']);
  assert.equal(r.status, 1);
  assert.ok(r.stdout, JSON.stringify(r));
  assert.equal(JSON.parse(r.stdout).error, 'git_remote_unavailable');
  assert.ok(!r.stdout.includes('OLD'));
  assert.equal(git(f.local, 'rev-parse', 'HEAD'), f.initial);
});
test('other branches and concurrent invocations stop', async t => {
  const f = fixture(t);
  git(f.local, 'checkout', '-b', 'feature');
  assert.throws(() => synchronize(f.local), { code: 'git_branch_not_main' });
  git(f.local, 'checkout', 'main');
  const lock = path.join(f.local, '.git/zlib-cloud-sync.lock'); fs.mkdirSync(lock);
  const r = await node(f.local, ['scripts/zlib-workflow.mjs', 'status']);
  assert.ok(r.stdout, JSON.stringify(r));
  assert.equal(JSON.parse(r.stdout).error, 'git_workflow_busy');
  assert.ok(fs.existsSync(lock));
});
test('dead-process lock is recovered without skipping the remote check', async t => {
  const f = fixture(t); f.advance();
  const lock = path.join(f.local, '.git/zlib-cloud-sync.lock'); fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), '2147483647');
  const r = await node(f.local, ['scripts/zlib-workflow.mjs', 'status']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).version, 'NEW');
  assert.ok(!fs.existsSync(lock));
});
