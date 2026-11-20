#!/usr/bin/env node
// Cloud orchestration only. Drive uploads stay in the connected Drive tool.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { inflateRawSync } from 'node:zlib';

const repo = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
class WorkflowError extends Error {
  constructor(code, step, cliExit) {
    super(code);
    Object.assign(this, { code, step, cliExit });
  }
}
const fail = (code, step) => { throw new WorkflowError(code, step); };
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function writeJSON(file, value) {
  const staging = `${file}.${process.pid}.new`;
  try {
    fs.writeFileSync(staging, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(staging, file);
  } finally { fs.rmSync(staging, { force: true }); }
}
function privateDirectory(dir) {
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
      (process.getuid && stat.uid !== process.getuid())) fail('unsafe_state_directory');
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
function category(raw) {
  const s = raw.toLowerCase();
  for (const [code, pattern] of [
    ['session_save_failed', /failed to save session/],
    ['credentials_rejected', /incorrect (email|password)|invalid credentials/],
    ['eapi_auth_refused', /authorization failed|login was rejected/],
    ['antibot', /anti.bot|diamwall|captcha|http (403|429|513|517)/],
    ['network', /timeout|timed out|network|tls|certificate|no such host|connection/],
    ['response_parsing', /invalid eapi response|cannot unmarshal|invalid character/],
    ['cli_arguments', /unknown flag|unknown command|requires.*arg/],
  ]) if (pattern.test(s)) return code;
  return 'cli_failed';
}

// Inspect the ZIP directory without extracting any server-controlled paths.
export function validateEpub(file) {
  const b = fs.readFileSync(file);
  let end = b.length - 22;
  for (; end >= Math.max(0, b.length - 65557); end--) {
    if (b.readUInt32LE(end) === 0x06054b50) break;
  }
  if (end < Math.max(0, b.length - 65557)) fail('invalid_epub');
  let offset = b.readUInt32LE(end + 16);
  const count = b.readUInt16LE(end + 10);
  let mime = false, container = false;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > b.length || b.readUInt32LE(offset) !== 0x02014b50) fail('invalid_epub');
    const nameSize = b.readUInt16LE(offset + 28);
    const name = b.subarray(offset + 46, offset + 46 + nameSize).toString();
    if (name === 'META-INF/container.xml') container = true;
    if (name === 'mimetype') {
      const local = b.readUInt32LE(offset + 42);
      if (local + 30 > b.length || b.readUInt32LE(local) !== 0x04034b50) fail('invalid_epub');
      const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
      const packed = b.subarray(start, start + b.readUInt32LE(offset + 20));
      const method = b.readUInt16LE(offset + 10);
      const value = method === 0 ? packed : method === 8 ? inflateRawSync(packed, { maxOutputLength: 128 }) : null;
      mime = value?.toString() === 'application/epub+zip';
    }
    offset += 46 + nameSize + b.readUInt16LE(offset + 30) + b.readUInt16LE(offset + 32);
  }
  if (!mime || !container) fail('invalid_epub');
}

export function createWorkflow({
  launcher = path.join(repo, 'scripts/zlib.sh'),
  stateRoot = path.join(tmpdir(), `zlib-cloud-${process.getuid?.() ?? 'user'}`),
  environment = process.env,
  timeout = 240000,
} = {}) {
  // Artifacts and credentials must never be created in the checkout.
  stateRoot = path.resolve(stateRoot);
  if (stateRoot === path.resolve(repo) || stateRoot.startsWith(path.resolve(repo) + path.sep)) fail('state_inside_checkout');
  privateDirectory(stateRoot);
  const secrets = ['ZLIB_LOGIN_EMAIL', 'ZLIB_LOGIN_PASSWORD'].map(k => environment[k]).filter(Boolean);
  const clean = value => {
    if (Array.isArray(value)) return value.map(clean);
    if (typeof value !== 'string') return value;
    let s = value.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    for (const secret of secrets) s = s.split(secret).join('[redacted]');
    return s.replace(/https?:\/\/\S+/gi, '[url]').slice(0, 1000);
  };
  const identity = b => {
    const delivery_id = digest(String(b.id)).slice(0, 32);
    const title = String(clean(b.name ?? 'book')).normalize('NFKC').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 80) || 'book';
    return { delivery_id, delivery_name: `${title}--${delivery_id}.epub` };
  };
  const safeBook = b => ({
    ...Object.fromEntries(['id', 'name', 'authors', 'language', 'year', 'extension', 'size', 'publisher', 'edition']
      .filter(k => b[k] !== undefined).map(k => [k, clean(b[k])])),
    ...(b.extension === 'epub' && b.id ? identity(b) : {}),
  });
  const jobPath = key => {
    if (!/^[a-f0-9]{32}$/.test(key ?? '')) fail('invalid_delivery_id');
    return path.join(stateRoot, key);
  };
  const pending = dir => readJSON(path.join(dir, 'state.json'));
  const describe = dir => {
    const s = pending(dir);
    if (s.phase === 'delivered') return s;
    if (['ready', 'uploading'].includes(s.phase)) {
      const p = path.join(dir, s.name);
      if (!fs.existsSync(p) || fs.lstatSync(p).isSymbolicLink() || digest(fs.readFileSync(p)) !== s.sha256) fail('artifact_changed');
      return { ...s, path: p };
    }
    return { ...s, recovery_directory: dir };
  };
  let controller;
  async function cli(args, home, step, login = false) {
    if (controller.signal.aborted) fail('cancelled', step);
    const env = { HOME: home };
    for (const k of ['PATH', 'SystemRoot', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'ZLIB_PROXY']) {
      if (environment[k]) env[k] = environment[k];
    }
    // The CLI receives credentials only for login, not through its environment.
    return await new Promise((resolve, reject) => {
      const child = spawn(launcher, args, { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '', size = 0, overflow = false, timedOut = false;
      const abort = () => child.kill('SIGKILL');
      controller.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; abort(); }, timeout);
      child.stdout.on('data', b => { size += b.length; if (size > 8 * 1024 * 1024) { overflow = true; abort(); } else out += b; });
      child.stderr.on('data', b => { if (err.length < 65536) err += b.toString().slice(0, 65536 - err.length); });
      child.on('error', () => {}); // Never expose a spawn error containing argv.
      child.on('close', code => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', abort);
        if (controller.signal.aborted) return reject(new WorkflowError('cancelled', step));
        if (timedOut) return reject(new WorkflowError('timeout', step));
        if (overflow) return reject(new WorkflowError('response_too_large', step));
        if (code !== 0) return reject(new WorkflowError(category(err), step, code));
        if (login) return resolve(null);
        try { resolve(JSON.parse(out)); } catch { reject(new WorkflowError('response_parsing', step)); }
      });
    });
  }
  async function authenticated(fn, requestedDomain) {
    for (const k of ['ZLIB_LOGIN_EMAIL', 'ZLIB_LOGIN_PASSWORD']) if (!environment[k]?.trim()) fail('missing_credentials', 'login');
    const home = fs.mkdtempSync(path.join(stateRoot, `auth-${process.pid}-`));
    try {
      const domains = await cli(['doctor', '--json'], home, 'doctor');
      if (!Array.isArray(domains)) fail('response_parsing', 'doctor');
      const healthy = domains.filter(d => d.status === 'healthy' && /^https:\/\/[^/]+\/?$/.test(d.domain));
      const domain = requestedDomain ? healthy.find(d => d.domain === requestedDomain)?.domain :
        (healthy.find(d => d.domain === 'https://z-lib.gd') ?? healthy[0])?.domain;
      if (!domain) fail('no_verified_domain', 'doctor');
      await cli(['login', '--domain', domain, '--email', environment.ZLIB_LOGIN_EMAIL, '--password', environment.ZLIB_LOGIN_PASSWORD], home, 'login', true);
      const profile = await cli(['profile', '--json'], home, 'profile');
      if (!profile || typeof profile !== 'object' || Array.isArray(profile) || !Object.keys(profile).length) fail('response_parsing', 'profile');
      if (profile.quota_known && profile.daily_remaining === 0) {
        // Search is still allowed; the fetch callback checks this flag.
        return await fn(home, true);
      }
      return await fn(home, false);
    } finally {
      try { fs.rmSync(home, { recursive: true, force: true }); }
      catch { fail('session_cleanup_failed', 'cleanup'); }
    }
  }
  return async function workflow(options) {
    const lock = path.join(stateRoot, 'lock');
    if (fs.existsSync(lock)) {
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1 || alive(pid)) fail('workflow_busy');
      fs.unlinkSync(lock);
    }
    const fd = fs.openSync(lock, 'wx', 0o600);
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    controller = new AbortController();
    const cancel = () => controller.abort();
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    try {
      // Recover sessions orphaned by an uncatchable kill; never remove a live HOME.
      for (const name of fs.readdirSync(stateRoot)) {
        const match = /^auth-(\d+)-/.exec(name);
        if (match && !alive(Number(match[1]))) fs.rmSync(path.join(stateRoot, name), { recursive: true, force: true });
      }
      const { action } = options;
      if (action === 'status') return { deliveries: fs.readdirSync(stateRoot).filter(n => /^[a-f0-9]{32}$/.test(n)).map(n => describe(jobPath(n))) };
      if (['begin-upload', 'complete'].includes(action)) {
        const dir = jobPath(options.delivery);
        const s = describe(dir);
        if (s.phase === 'delivered') {
          // Finish a previously interrupted cleanup without touching other files.
          fs.rmSync(path.join(dir, s.name), { force: true });
          return s;
        }
        if (!['ready', 'uploading'].includes(s.phase)) fail('download_outcome_uncertain');
        if (action === 'begin-upload') {
          if (s.phase === 'uploading') fail('upload_outcome_uncertain');
          delete s.path;
          s.phase = 'uploading';
          writeJSON(path.join(dir, 'state.json'), s);
          return describe(dir);
        }
        const m = options.metadata;
        const name = m?.name ?? m?.title;
        const url = m?.webViewLink ?? m?.url;
        const id = m?.id;
        if (!/^[\w-]+$/.test(id ?? '') || name !== s.name || String(m?.size) !== String(s.size)) fail('drive_metadata_mismatch');
        if (m.shared !== false || !Array.isArray(m.permissions) || m.permissions.length !== 1 ||
            m.permissions[0].type !== 'user' || m.permissions[0].role !== 'owner') fail('drive_not_private');
        let u;
        try { u = new URL(url); } catch { fail('invalid_drive_link'); }
        if (u.origin !== 'https://drive.google.com' || u.pathname !== `/file/d/${id}/view` || u.username || u.password || u.hash ||
            [...u.searchParams.keys()].some(k => k !== 'usp')) fail('invalid_drive_link');
        const receipt = { delivery_id: s.delivery_id, phase: 'delivered', name: s.name, size: s.size, sha256: s.sha256, drive_id: id, url };
        writeJSON(path.join(dir, 'state.json'), receipt);
        fs.unlinkSync(path.join(dir, s.name));
        return receipt;
      }
      if (!['search', 'fetch'].includes(action) || !options.query?.trim()) fail('invalid_arguments');
      if (action === 'fetch' && (!options.rightsConfirmed || !/^[\w-]+:[\w-]+$/.test(options.bookId ?? ''))) fail('download_requires_rights_and_selection');
      const key = action === 'fetch' ? digest(options.bookId).slice(0, 32) : null;
      const dir = key && jobPath(key);
      if (dir && fs.existsSync(dir)) return describe(dir); // No second download, even after uncertainty.
      return await authenticated(async (home, quotaEmpty) => {
        const args = ['search', options.query, '--json', '--ext', options.ext ?? 'epub', '--count', String(options.count ?? 10), '--page', String(options.page ?? 1)];
        if (options.language) args.push('--language', options.language);
        if (options.fromYear) args.push('--from-year', String(options.fromYear));
        if (options.toYear) args.push('--to-year', String(options.toYear));
        const result = await cli(args, home, 'search');
        if (!result || !Array.isArray(result.books) || result.books.some(b => !b || typeof b !== 'object' || Array.isArray(b))) fail('response_parsing', 'search');
        if (action === 'search') return { books: result.books.map(safeBook), page: result.page, total_pages: result.total_pages };
        const book = result.books.find(b => b.id === options.bookId);
        if (!book) fail('selection_not_in_results');
        if (book.extension?.toLowerCase() !== 'epub' || (options.ext && options.ext !== 'epub')) fail('epub_required');
        if (quotaEmpty) fail('quota_exhausted');
        privateDirectory(dir);
        const state = { delivery_id: key, phase: 'uncertain', book: safeBook(book) };
        writeJSON(path.join(dir, 'state.json'), state);
        const downloadDir = path.join(dir, 'download');
        privateDirectory(downloadDir);
        // Preserve the source bytes: the CLI's size precedes optional metadata edits.
        const downloaded = await cli(['download', options.bookId, '--json', '--no-embed', '--dir', downloadDir], home, 'download');
        if (typeof downloaded?.path !== 'string') fail('download_response_invalid');
        const file = path.resolve(downloaded.path);
        const real = fs.realpathSync(file);
        if (!real.startsWith(fs.realpathSync(downloadDir) + path.sep) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) fail('download_path_escape');
        const size = fs.statSync(file).size;
        if (!size || size !== downloaded.size) fail('download_size_mismatch');
        validateEpub(file);
        state.name = identity(book).delivery_name;
        fs.renameSync(file, path.join(dir, state.name));
        fs.chmodSync(path.join(dir, state.name), 0o600);
        fs.rmSync(downloadDir, { recursive: true });
        Object.assign(state, { phase: 'ready', size, sha256: digest(fs.readFileSync(path.join(dir, state.name))) });
        writeJSON(path.join(dir, 'state.json'), state);
        return describe(dir);
      }, options.domain);
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
      fs.unlinkSync(lock);
    }
  };
}

export async function main() {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      'book-id': { type: 'string' }, 'rights-confirmed': { type: 'boolean' },
      delivery: { type: 'string' }, domain: { type: 'string' }, language: { type: 'string' },
      ext: { type: 'string' }, count: { type: 'string' }, page: { type: 'string' },
      'from-year': { type: 'string' }, 'to-year': { type: 'string' },
    } });
    const [action, query, ...extra] = positionals;
    if (extra.length) fail('invalid_arguments');
    for (const k of ['count', 'page', 'from-year', 'to-year']) if (values[k] && !/^[1-9]\d{0,3}$/.test(values[k])) fail('invalid_arguments');
    if (Number(values.count ?? 10) > 50) fail('invalid_arguments');
    const metadata = action === 'complete' ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
    const run = createWorkflow();
    const result = await run({ action, query, ...values, bookId: values['book-id'], rightsConfirmed: values['rights-confirmed'], fromYear: values['from-year'], toYear: values['to-year'], metadata });
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (e) {
    // Never print Error objects: spawn failures may embed passwords in argv.
    console.log(JSON.stringify({ ok: false, error: e instanceof WorkflowError ? e.code : 'local_or_invalid_data', step: e.step, cli_exit: e.cliExit }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
