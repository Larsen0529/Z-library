import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { reconcileDrive, deliver } from './zlib-drive.mjs';

const bytes = Buffer.from('fixture EPUB bytes');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const book = { id: '123:fixture', name: 'Fixture', authors: ['Fixture Author'], language: 'English', publisher: 'Fixture Publisher', delivery_name: 'Fixture--fixture.epub' };
const target = { name: book.delivery_name, book };
const metadata = (id = 'fixture') => ({ id, name: target.name, size: bytes.length, mimeType: 'application/epub+zip', shared: false,
  permissions: [{ type: 'user', role: 'owner' }], webViewLink: `https://drive.google.com/file/d/${id}/view` });
function fixture(t, pages = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'drive-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], copies = [];
  const drive = async (op, args) => {
    calls.push({ op, ...args });
    if (op === 'search' || op === 'list') return pages[`${op}:${args.page_token ?? ''}`] ?? { files: [], complete: true };
    if (op === 'metadata') return metadata(args.id);
    if (op === 'readback') { const p = path.join(root, `copy-${copies.length}`); fs.writeFileSync(p, bytes); copies.push(p); return { path: p }; }
    throw new Error('unexpected upload');
  };
  return { drive, calls, copies, validateEpub: () => {}, readMetadata: async () => ({ title: book.name, authors: book.authors, languages: ['en'], publisher: book.publisher }) };
}
test('search omission falls back to all folder pages, including empty pages', async t => {
  const f = fixture(t, { 'list:': { files: [], next_page_token: 'second' }, 'list:second': { files: [], next_page_token: 'third' },
    'list:third': { files: [metadata()], complete: true } });
  const r = await reconcileDrive({ ...f, target });
  assert.equal(r.reused, true); assert.equal(r.sha256, sha256);
  assert.deepEqual(f.calls.filter(c => c.op === 'list').map(c => c.page_token), [undefined, 'second', 'third']);
  assert.ok(f.copies.every(p => !fs.existsSync(p)));
});
test('search pages are exhausted before accepting absence', async t => {
  const f = fixture(t, { 'search:': { files: [], next_page_token: 'second' }, 'search:second': { files: [metadata()], complete: true } });
  assert.ok(await reconcileDrive({ ...f, target }));
  assert.ok(!f.calls.some(c => c.op === 'list'));
});
test('unknown search completeness still triggers the complete folder fallback', async t => {
  const f = fixture(t, { 'search:': { files: [] }, 'list:': { files: [metadata()], complete: true } });
  assert.equal((await reconcileDrive({ ...f, target })).reused, true);
  assert.ok(f.calls.some(c => c.op === 'list'));
});
test('identical duplicates are reconciled; conflicting bytes and permissions stop', async t => {
  const f = fixture(t, { 'search:': { files: [metadata(), metadata('second')], complete: true } });
  assert.ok(await reconcileDrive({ ...f, target }));
  for (const override of [{ shared: true }, { permissions: [] }, { size: bytes.length + 1 }, { mimeType: 'text/plain' }]) {
    const drive = (op, args) => op === 'metadata' ? { ...metadata(args.id), ...override } : f.drive(op, args);
    await assert.rejects(reconcileDrive({ ...f, drive, target }));
  }
  await assert.rejects(reconcileDrive({ ...f, target: { ...target, sha256: 'wrong' } }), { code: 'drive_content_mismatch' });
  await assert.rejects(reconcileDrive({ ...f, target, readMetadata: async () => ({ title: 'another work' }) }), { code: 'drive_book_identity_uncertain' });
  assert.ok(f.copies.every(p => !fs.existsSync(p)));
});
test('truncation, missing completeness and pagination loops fail closed', async t => {
  for (const pages of [{ 'list:': { files: [] } }, { 'list:': { files: [], complete: false } },
    { 'list:': { files: [], next_page_token: 'loop' }, 'list:loop': { files: [], next_page_token: 'loop' } }]) {
    await assert.rejects(reconcileDrive({ ...fixture(t, pages), target }));
  }
});
test('existing file prevents download and upload, even without local receipt', async t => {
  const f = fixture(t, { 'list:': { files: [metadata()], complete: true } });
  const calls = [];
  const run = async options => { calls.push(options.action); if (options.action === 'status') return { deliveries: [] }; if (options.action === 'search') return { books: [book] }; throw new Error('duplicate download'); };
  const r = await deliver({ ...f, run, options: { action: 'deliver', bookId: book.id } });
  assert.equal(r.reused, true); assert.deepEqual(calls, ['status', 'search']);
});
test('uncertain upload reconciles first, never retries even on empty Drive', async t => {
  for (const exists of [false, true]) {
    const f = fixture(t, exists ? { 'list:': { files: [metadata()], complete: true } } : {});
    const calls = [];
    const run = async o => { calls.push(o.action); if (o.action === 'status') return { deliveries: [{ ...target, sha256, phase: 'uploading', delivery_id: 'fixture' }] }; if (o.action === 'search') return { books: [book] }; if (o.action === 'complete') return {}; throw new Error('blind retry'); };
    const task = deliver({ ...f, run, options: { action: 'deliver', bookId: book.id, delivery: 'fixture' } });
    if (exists) assert.equal((await task).reused, true); else await assert.rejects(task, { code: 'upload_outcome_uncertain' });
    assert.ok(!calls.includes('fetch') && !calls.includes('begin-upload'));
  }
});
test('new upload is checked twice and a lost response remains uncertain', async t => {
  const f = fixture(t); const calls = [];
  const run = async o => { calls.push(o.action); if (o.action === 'status') return { deliveries: [] }; if (o.action === 'search') return { books: [book] }; if (o.action === 'fetch') return { ...target, sha256, size: bytes.length, delivery_id: 'fixture', path: 'fixture.epub', phase: 'ready' }; if (o.action === 'begin-upload') return {}; throw new Error('must not complete'); };
  const drive = (op, args) => { if (op === 'upload') throw new Error('lost response'); return f.drive(op, args); };
  await assert.rejects(deliver({ ...f, drive, run, options: { action: 'deliver', bookId: book.id } }), /lost response/);
  assert.equal(f.calls.filter(c => c.op === 'list').length, 2);
  assert.deepEqual(calls, ['status', 'search', 'fetch', 'begin-upload']);
});
test('successful upload requires actual private metadata before completion', async t => {
  const f = fixture(t); const calls = [];
  const run = async o => {
    calls.push(o.action);
    if (o.action === 'status') return { deliveries: [] };
    if (o.action === 'search') return { books: [book] };
    if (o.action === 'fetch') return { ...target, sha256, size: bytes.length, delivery_id: 'fixture', path: 'fixture.epub', phase: 'ready' };
    if (o.action === 'begin-upload') return {};
    if (o.action === 'complete') { assert.equal(o.metadata.id, 'new-file'); return { phase: 'delivered' }; }
    throw new Error('unexpected action');
  };
  const drive = async (op, args) => op === 'upload' ? { id: 'new-file' } : f.drive(op, args);
  assert.equal((await deliver({ ...f, drive, run, options: { action: 'deliver', bookId: book.id } })).phase, 'delivered');
  assert.deepEqual(calls, ['status', 'search', 'fetch', 'begin-upload', 'complete']);
});
test('prior delivered receipts must be reverified', async t => {
  const f = fixture(t);
  const run = async o => o.action === 'status' ? { deliveries: [{ ...target, book, sha256, phase: 'delivered', delivery_id: 'fixture' }] } : { books: [book] };
  await assert.rejects(deliver({ ...f, run, options: { action: 'deliver', bookId: book.id } }), { code: 'drive_prior_delivery_missing' });
});
