import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const failure = code => { throw Object.assign(new Error(code), { code }); };
function git(repo, args, allowed = [0]) {
  const environment = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete environment.ZLIB_LOGIN_EMAIL;
  delete environment.ZLIB_LOGIN_PASSWORD;
  const r = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', timeout: 60000,
    env: environment,
  });
  // Git errors can contain credential-bearing remote URLs. Never print them.
  if (!allowed.includes(r.status)) failure(args[0] === 'fetch' ? 'git_remote_unavailable' : 'git_check_failed');
  return r;
}
export function synchronize(repo) {
  if (git(repo, ['status', '--porcelain', '--untracked-files=all']).stdout.trim()) failure('git_worktree_dirty');
  const branch = git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1]).stdout.trim();
  if (branch && branch !== 'main') failure('git_branch_not_main');
  git(repo, ['fetch', '--no-tags', 'origin', 'refs/heads/main']);
  const remote = git(repo, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']).stdout.trim();
  if (git(repo, ['merge-base', '--is-ancestor', 'HEAD', remote], [0, 1]).status !== 0) failure('git_not_fast_forward');
  // Recheck after network I/O. Never stash, reset, checkout, rebase or push.
  if (git(repo, ['status', '--porcelain', '--untracked-files=all']).stdout.trim()) failure('git_worktree_dirty');
  git(repo, ['merge', '--ff-only', '--no-edit', remote]);
  const head = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  if (head !== remote || git(repo, ['status', '--porcelain', '--untracked-files=all']).stdout.trim()) failure('git_sync_incomplete');
  return head;
}
export async function runSynchronized(repo, args) {
  let lock, acquired = false;
  try {
    const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']).stdout.trim();
    lock = path.join(gitDir, 'zlib-cloud-sync.lock');
    if (fs.existsSync(lock)) {
      let owner;
      try { owner = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8')); } catch { /* acquiring or unknown lock: stop */ }
      if (Number.isSafeInteger(owner) && owner > 0) {
        let dead = false;
        try { process.kill(owner, 0); } catch (e) { dead = e.code === 'ESRCH'; }
        if (dead) { fs.unlinkSync(path.join(lock, 'pid')); fs.rmdirSync(lock); }
      }
    }
    try { fs.mkdirSync(lock); acquired = true; } catch { failure('git_workflow_busy'); }
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 });
    const head = synchronize(repo);
    fs.writeSync(2, JSON.stringify({ git_sync: 'verified', head }) + '\n');
    // New process + import from disk: no old module remains in memory.
    const url = pathToFileURL(path.join(repo, 'scripts/zlib-workflow-core.mjs')).href;
    const code = `const {main}=await import(${JSON.stringify(url)}); await main(process.argv.slice(1));`;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code, '--', ...args], { stdio: 'inherit' });
    const forward = signal => child.kill(signal);
    const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    try {
      process.exitCode = await new Promise(resolve => {
        child.on('error', () => resolve(1));
        child.on('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
      });
    } finally {
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    }
  } catch (e) {
    fs.writeSync(1, JSON.stringify({ ok: false, error: e.code?.startsWith('git_') ? e.code : 'git_check_failed', step: 'git_sync' }) + '\n');
    process.exitCode = 1;
  } finally {
    // Only remove the lock acquired by this invocation.
    if (acquired) { fs.rmSync(path.join(lock, 'pid'), { force: true }); fs.rmdirSync(lock); }
  }
}
