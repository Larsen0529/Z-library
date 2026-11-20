// Full public-entry simulation. No live account, book download or Drive upload.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

function epub() {
  const locals = [], central = []; let offset = 0;
  for (const [name, value] of [['mimetype', 'application/epub+zip'], ['META-INF/container.xml', '<container/>']]) {
    const n = Buffer.from(name), b = Buffer.from(value), h = Buffer.alloc(30), c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50); h.writeUInt32LE(b.length, 18); h.writeUInt32LE(b.length, 22); h.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt32LE(b.length, 20); c.writeUInt32LE(b.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(h, n, b); central.push(c, n); offset += h.length + n.length + b.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}
function harness(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'delivery-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), temporary = path.join(root, 'temporary'), log = path.join(root, 'cli.jsonl');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true }); fs.mkdirSync(temporary);
  for (const file of ['zlib-workflow.mjs', 'zlib-sync.mjs', 'zlib-workflow-core.mjs', 'zlib-drive.mjs', 'zlib.sh']) {
    fs.copyFileSync(new URL(file, import.meta.url), path.join(repo, 'scripts', file));
  }
  const git = (...args) => {
    const r = spawnSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git('init', '-b', 'main'); git('add', '.'); git('commit', '-m', 'fixture');
  git('clone', '--bare', repo, path.join(root, 'origin.git'));
  git('remote', 'add', 'origin', path.join(root, 'origin.git')); git('checkout', '--detach');
  const cli = path.join(root, '.zlib-tools/codex-install-home/.local/bin/zlib');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  const bytes = epub(), book = { id: '123:fixture', name: 'Fixture', authors: ['Fixture Author'], language: 'English', publisher: 'Fixture Publisher', extension: 'epub' };
  const key = createHash('sha256').update(book.id).digest('hex').slice(0, 32), name = `Fixture--${key}.epub`;
  fs.writeFileSync(cli, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2),cmd=a[0];
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({cmd,home:process.env.HOME,hasCredentials:!!process.env.ZLIB_LOGIN_PASSWORD})+'\\n');
const out=v=>fs.writeSync(1,JSON.stringify(v)+'\\n');
if(cmd==='doctor')out([{domain:'https://z-lib.gd',status:'healthy'}]);
else if(cmd==='login'){fs.mkdirSync(path.join(process.env.HOME,'.config/zlib'),{recursive:true});fs.writeFileSync(path.join(process.env.HOME,'.config/zlib/session.json'),'fixture');}
else if(cmd==='profile')out({quota_known:true,daily_remaining:3});
else if(cmd==='search')out({books:[${JSON.stringify(book)}],page:1,total_pages:1});
else if(cmd==='download'){const p=path.join(a[a.indexOf('--dir')+1],'fixture.epub');const b=Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64');fs.writeFileSync(p,b);out({path:p,size:b.length});}
else if(cmd==='meta')out({title:'Fixture',authors:['Fixture Author'],languages:['en'],publisher:'Fixture Publisher'});
else process.exit(1);
`, { mode: 0o700 });
  const metadata = id => ({ id, name, mime_type: 'application/epub+zip', size: String(bytes.length), shared: false,
    permissions: [{ type: 'user', role: 'owner' }], url: `https://drive.google.com/file/d/${id}/view` });
  const calls = [], uploads = []; let exists = false;
  const run = ({ existing = exists, loseUploadResponse = false, strict = false } = {}) => new Promise((resolve, reject) => {
    exists = existing;
    const child = spawn(process.execPath, ['scripts/zlib-workflow.mjs', 'deliver', 'Fixture', '--language', 'English', '--book-id', book.id, '--rights-confirmed', ...(strict ? ['--strict-drive-dedup'] : [])], {
      cwd: repo, env: { ...process.env, TMPDIR: temporary, ZLIB_LOGIN_EMAIL: 'reader@example.com', ZLIB_LOGIN_PASSWORD: 'fixture-password' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('delivery fixture timeout')); }, 20000);
    t.after(() => child.kill('SIGKILL'));
    let final, stderr = '', parseError;
    child.stderr.on('data', b => { stderr += b; });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        const request = JSON.parse(line);
        if (!request.connector_request) { final = request; child.stdin.end(); return; }
        calls.push(request.operation); let result;
        if (request.operation === 'search') result = { structuredContent: { results: [] } };
        else if (request.operation === 'list') result = { structuredContent: { files: exists ? [metadata('fixture-drive-id')] : [] } };
        else if (request.operation === 'metadata') result = metadata(request.arguments.id);
        else if (request.operation === 'readback') { const p = path.join(temporary, `readback-${calls.length}.epub`); fs.writeFileSync(p, bytes); result = { path: p }; }
        else if (request.operation === 'upload') {
          assert.deepEqual(fs.readFileSync(request.arguments.path), bytes);
          uploads.push(request.arguments); exists = true;
          if (loseUploadResponse) { child.stdin.write(JSON.stringify({ request_id: request.request_id, error: 'lost_response' }) + '\n'); return; }
          result = { id: 'fixture-drive-id' };
        } else throw new Error('unexpected connector operation');
        child.stdin.write(JSON.stringify({ request_id: request.request_id, result }) + '\n');
      } catch (e) { parseError = e; child.kill('SIGKILL'); }
    });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); if (parseError) reject(parseError); else resolve({ code, final, stderr }); });
  });
  const commands = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const clean = () => {
    assert.ok(commands().every(c => !c.hasCredentials));
    assert.ok(commands().every(c => !fs.existsSync(c.home)));
    assert.ok(!fs.readdirSync(temporary).some(n => n.endsWith('.epub')));
    assert.equal(git('status', '--porcelain'), '');
  };
  return { run, calls, uploads, commands, clean };
}
const cloudOnly = { skip: process.platform === 'win32' };
test('public entry: omitted search + incomplete folder still reuse without transfers', cloudOnly, async t => {
  const f = harness(t), r = await f.run({ existing: true });
  assert.equal(r.code, 0, r.stderr); assert.equal(r.final.reused, true);
  assert.match(r.stderr, /git_sync.*verified/);
  assert.equal(f.commands().filter(c => c.cmd === 'download').length, 0);
  assert.equal(f.uploads.length, 0); f.clean();
});
test('public entry: new EPUB is fetched once, uploaded privately and cleaned', cloudOnly, async t => {
  const f = harness(t), r = await f.run();
  assert.equal(r.code, 0, r.stderr); assert.equal(r.final.phase, 'delivered');
  assert.equal(r.final.deduplication.absence_proven, false);
  assert.equal(f.commands().filter(c => c.cmd === 'download').length, 1);
  assert.equal(f.uploads.length, 1); assert.equal(f.calls.filter(c => c === 'list').length, 2);
  const networkCalls = f.commands().filter(c => c.cmd !== 'meta').length;
  const repeated = await f.run();
  assert.equal(repeated.code, 0, repeated.stderr); assert.equal(repeated.final.reused, true);
  assert.equal(f.commands().filter(c => c.cmd !== 'meta').length, networkCalls);
  assert.equal(f.uploads.length, 1);
  f.clean();
});
test('public entry: lost upload response is reconciled on restart without another transfer', cloudOnly, async t => {
  const f = harness(t), first = await f.run({ loseUploadResponse: true });
  assert.equal(first.code, 1); assert.equal(first.final.error, 'drive_connector_failed');
  const second = await f.run();
  assert.equal(second.code, 0, second.stderr); assert.equal(second.final.reused, true);
  assert.equal(f.commands().filter(c => c.cmd === 'download').length, 1);
  assert.equal(f.uploads.length, 1); f.clean();
});
test('public entry: strict policy refuses unproven absence without fetching', cloudOnly, async t => {
  const f = harness(t), r = await f.run({ strict: true });
  assert.equal(r.code, 1); assert.equal(r.final.error, 'drive_listing_incomplete');
  assert.equal(f.commands().filter(c => c.cmd === 'download').length, 0);
  assert.equal(f.uploads.length, 0); f.clean();
});
