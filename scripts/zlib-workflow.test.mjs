import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWorkflow, validateEpub } from './zlib-workflow.mjs';

// Minimal archive with local headers and a central directory, no extraction.
function epub() {
  const local = [], central = [];
  let offset = 0;
  for (const [name, text] of [['mimetype', 'application/epub+zip'], ['META-INF/container.xml', '<container/>']]) {
    const n = Buffer.from(name), data = Buffer.from(text);
    const h = Buffer.alloc(30), c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    local.push(h, n, data); central.push(c, n);
    offset += h.length + n.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10); end.writeUInt32LE(Buffer.concat(central).length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
function fixture(t, config = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'workflow-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'state'), log = path.join(root, 'calls.jsonl');
  const launcher = path.join(root, 'fake-cli.cjs');
  const source = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const config=${JSON.stringify(config)},log=${JSON.stringify(log)};
const a=process.argv.slice(2),cmd=a[0],home=process.env.HOME;
fs.appendFileSync(log,JSON.stringify({cmd,home,credentialsInEnv:!!process.env.ZLIB_LOGIN_PASSWORD})+'\\n');
const output=v=>fs.writeSync(1,JSON.stringify(v)+'\\n');
if(config.fail===cmd){fs.writeSync(2,config.error||'fixture failure');process.exit(1)}
if(config.badJSON===cmd){fs.writeSync(1,'not JSON');process.exit(0)}
if(config.hang===cmd){setTimeout(()=>{},60000)}
else if(cmd==='doctor')output(config.noDomain?[]:[{domain:'https://z-lib.gd',status:'healthy'}]);
else if(cmd==='login'){
 if(a[a.indexOf('--email')+1]!=='reader@example.com'||a[a.indexOf('--password')+1]!=='fixture-password')process.exit(1);
 fs.mkdirSync(path.join(home,'.config/zlib'),{recursive:true});
 fs.writeFileSync(path.join(home,'.config/zlib/session.json'),'fixture');
}
else if(cmd==='profile')output({quota_known:true,daily_remaining:config.quotaEmpty?0:5});
else if(cmd==='search')output({books:config.empty?[]:[{id:'123:fixture',name:'Public Domain Book',authors:['Fixture Author'],extension:config.format||'epub',language:'English',year:'1900',size:'1 KB',description:'not forwarded'}],page:1,total_pages:1});
else if(cmd==='download'){
 if(!a.includes('--no-embed')){fs.writeSync(2,'fixture requires original bytes');process.exit(1)}
 const dir=a[a.indexOf('--dir')+1],file=path.join(dir,'fixture.epub');
 const data=config.invalidEpub?Buffer.from('invalid'):Buffer.from(${JSON.stringify(epub().toString('base64'))},'base64');
 fs.writeFileSync(file,data);
 output({path:config.escape?${JSON.stringify(path.join(root, 'outside.epub'))}:file,size:data.length+(config.badSize?1:0)});
}
`;
  fs.writeFileSync(launcher, source, { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'outside.epub'), epub());
  const environment = { PATH: process.env.PATH, ZLIB_LOGIN_EMAIL: 'reader@example.com', ZLIB_LOGIN_PASSWORD: 'fixture-password' };
  const run = createWorkflow({ launcher, stateRoot, environment, timeout: config.timeout ?? 5000 });
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const noSessions = () => assert.deepEqual(fs.readdirSync(stateRoot).filter(n => n.startsWith('auth-')), []);
  return { root, stateRoot, launcher, environment, run, calls, noSessions };
}
const fetchOptions = { action: 'fetch', query: 'Public Domain Book', bookId: '123:fixture', rightsConfirmed: true };
const metadata = s => ({ id: 'fixture-drive-id', name: s.name, size: String(s.size), shared: false,
  permissions: [{ type: 'user', role: 'owner' }], url: 'https://drive.google.com/file/d/fixture-drive-id/view' });

test('search only, same HOME, secret isolation, cleanup', async t => {
  const f = fixture(t);
  const s = await f.run({ action: 'search', query: 'Public Domain Book' });
  assert.equal(s.books.length, 1);
  assert.match(s.books[0].delivery_id, /^[a-f0-9]{32}$/);
  assert.ok(s.books[0].delivery_name.endsWith(`${s.books[0].delivery_id}.epub`));
  assert.equal(s.books[0].description, undefined);
  assert.deepEqual(f.calls().map(c => c.cmd), ['doctor', 'login', 'profile', 'search']);
  assert.equal(new Set(f.calls().map(c => c.home)).size, 1);
  assert.ok(f.calls().every(c => !c.credentialsInEnv));
  assert.ok(!fs.existsSync(f.calls()[0].home));
  assert.deepEqual((await f.run({ action: 'status' })).deliveries, []);
  f.noSessions();
});

test('fetch, recover upload failure, verify receipt, clean file, deduplicate', async t => {
  const f = fixture(t);
  const s = await f.run(fetchOptions);
  validateEpub(s.path);
  assert.equal(fs.statSync(s.path).mode & 0o777, 0o600);
  assert.equal(new Set(f.calls().map(c => c.home)).size, 1);
  f.noSessions();
  const before = f.calls().length;
  assert.equal((await f.run(fetchOptions)).path, s.path);
  assert.equal(f.calls().length, before);
  await f.run({ action: 'begin-upload', delivery: s.delivery_id });
  await assert.rejects(f.run({ action: 'begin-upload', delivery: s.delivery_id }), { code: 'upload_outcome_uncertain' });
  assert.ok(fs.existsSync((await f.run({ action: 'status' })).deliveries[0].path));
  for (const wrong of [{ size: '0' }, { name: 'wrong.epub' }, { id: '../bad' }, { shared: true }, { permissions: [] },
    { permissions: [{ type: 'anyone', role: 'reader' }] }, { url: 'https://example.com/file' },
    { url: 'https://drive.google.com/file/d/fixture-drive-id/view?token=fixture' }]) {
    await assert.rejects(f.run({ action: 'complete', delivery: s.delivery_id, metadata: { ...metadata(s), ...wrong } }));
    assert.ok(fs.existsSync(s.path));
  }
  const receipt = await f.run({ action: 'complete', delivery: s.delivery_id, metadata: metadata(s) });
  assert.equal(receipt.phase, 'delivered');
  assert.ok(!fs.existsSync(s.path));
  assert.equal((await f.run(fetchOptions)).drive_id, 'fixture-drive-id');
  assert.equal(f.calls().length, before);
});

for (const [config, code] of [
  [{ fail: 'login', error: 'Incorrect email or password: fixture-password' }, 'credentials_rejected'],
  [{ fail: 'login', error: 'Authorization failed' }, 'eapi_auth_refused'],
  [{ fail: 'login', error: 'failed to save session: read-only file system' }, 'session_save_failed'],
  [{ fail: 'login', error: 'DiamWall HTTP 513' }, 'antibot'],
  [{ fail: 'login', error: 'network request failed' }, 'network'],
  [{ badJSON: 'profile' }, 'response_parsing'],
  [{ badJSON: 'doctor' }, 'response_parsing'],
  [{ badJSON: 'search' }, 'response_parsing'],
  [{ noDomain: true }, 'no_verified_domain'],
  [{ quotaEmpty: true }, 'quota_exhausted'],
  [{ empty: true }, 'selection_not_in_results'],
  [{ format: 'pdf' }, 'epub_required'],
  [{ hang: 'login', timeout: 250 }, 'timeout'],
]) test(`failure ${JSON.stringify(config)} cleans authentication`, async t => {
  const f = fixture(t, config);
  await assert.rejects(f.run(fetchOptions), e => e.code === code && !e.message.includes('fixture-password'));
  f.noSessions();
  assert.equal(f.calls().filter(c => c.cmd === 'login').length <= 1, true);
});

for (const config of [{ fail: 'download' }, { invalidEpub: true }, { badSize: true }, { escape: true }]) {
  test(`uncertain download retained, never retried ${JSON.stringify(config)}`, async t => {
    const f = fixture(t, config);
    await assert.rejects(f.run(fetchOptions));
    f.noSessions();
    const before = f.calls().length;
    const s = await f.run(fetchOptions);
    assert.equal(s.phase, 'uncertain');
    assert.ok(fs.existsSync(s.recovery_directory));
    assert.equal(f.calls().length, before);
  });
}

test('rights and full selection required before any network operation', async t => {
  const f = fixture(t);
  for (const opts of [{ rightsConfirmed: false }, { bookId: '../bad' }]) {
    await assert.rejects(f.run({ ...fetchOptions, ...opts }), { code: 'download_requires_rights_and_selection' });
  }
  assert.deepEqual(f.calls(), []);
});

test('missing credentials, unknown domain, and empty search are explicit', async t => {
  const f = fixture(t, { empty: true });
  assert.deepEqual((await f.run({ action: 'search', query: 'missing' })).books, []);
  await assert.rejects(f.run({ ...fetchOptions, domain: 'https://example.com' }), { code: 'no_verified_domain' });
  f.environment.ZLIB_LOGIN_PASSWORD = '';
  await assert.rejects(f.run(fetchOptions), { code: 'missing_credentials' });
  f.noSessions();
});

test('modified artifact and unsafe state directory are rejected', async t => {
  const f = fixture(t);
  const s = await f.run(fetchOptions);
  fs.appendFileSync(s.path, 'changed');
  await assert.rejects(f.run({ action: 'begin-upload', delivery: s.delivery_id }), { code: 'artifact_changed' });
  fs.chmodSync(f.stateRoot, 0o755);
  assert.throws(() => createWorkflow({ stateRoot: f.stateRoot }), { code: 'unsafe_state_directory' });
});

test('dead-process authentication is removed and live lock is respected', async t => {
  const f = fixture(t);
  const stale = path.join(f.stateRoot, 'auth-2147483647-fixture');
  fs.mkdirSync(stale); fs.writeFileSync(path.join(stale, 'session.json'), 'fixture');
  await f.run({ action: 'status' });
  assert.ok(!fs.existsSync(stale));
  fs.writeFileSync(path.join(f.stateRoot, 'lock'), String(process.pid));
  await assert.rejects(f.run({ action: 'status' }), { code: 'workflow_busy' });
});

test('SIGTERM kills child, cleans HOME, leaves recoverable download state', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t, { hang: 'download' });
  const runner = path.join(f.root, 'runner.mjs');
  fs.writeFileSync(runner, `import {createWorkflow} from ${JSON.stringify(new URL('./zlib-workflow.mjs', import.meta.url).href)};
try { await createWorkflow(${JSON.stringify({ launcher: f.launcher, stateRoot: f.stateRoot, environment: f.environment })})(${JSON.stringify(fetchOptions)}); }
catch(e) { (await import('node:fs')).writeSync(1,e.code); }
`);
  const child = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', b => { output += b; });
  const closed = new Promise(resolve => child.on('close', resolve));
  t.after(() => child.kill('SIGKILL'));
  const deadline = Date.now() + 10000;
  while (!f.calls().some(c => c.cmd === 'download')) {
    if (Date.now() > deadline) throw new Error('fixture did not start');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  child.kill('SIGTERM');
  await closed;
  assert.match(output, /cancelled/);
  f.noSessions();
  assert.equal((await f.run({ action: 'status' })).deliveries[0].phase, 'uncertain');
});
