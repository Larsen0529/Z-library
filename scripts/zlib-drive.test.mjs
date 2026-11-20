import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { reconcileDrive, deliver, normalizeDrivePage, searchArguments } from './zlib-drive.mjs';

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
test('missing folder completeness remains unknown; pagination loops fail', async t => {
  for (const pages of [{ 'list:': { files: [] } }, { 'list:': { files: [], complete: false } }]) {
    const r = await reconcileDrive({ ...fixture(t, pages), target });
    assert.equal(r.phase, 'not_observed'); assert.equal(r.deduplication.absence_proven, false);
  }
  await assert.rejects(reconcileDrive({ ...fixture(t, {
    'list:': { files: [], next_page_token: 'loop' }, 'list:loop': { files: [], next_page_token: 'loop' },
  }), target }), { code: 'drive_pagination_loop' });
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

test('actual unmarked connector pages can reuse a visible existing EPUB', async t => {
  const f = fixture(t, { 'search:': { results: [] }, 'list:': { files: [metadata()] } });
  const calls = [];
  const run = async o => { calls.push(o.action); if (o.action === 'status') return { deliveries: [] }; if (o.action === 'search') return { books: [book] }; throw new Error('duplicate transfer'); };
  const r = await deliver({ ...f, run, options: { action: 'deliver', bookId: book.id } });
  assert.equal(r.reused, true);
  assert.equal(r.deduplication.folder_complete, false);
  assert.deepEqual(calls, ['status', 'search']);
});
test('compatibility delivery uploads once without inventing absence or completeness', async t => {
  const f = fixture(t, { 'search:': { results: [] }, 'list:': { files: [] } });
  const actions = [], uploads = [];
  const run = async o => {
    actions.push(o.action);
    if (o.action === 'status') return { deliveries: [] };
    if (o.action === 'search') return { books: [book] };
    if (o.action === 'fetch') return { ...target, size: bytes.length, sha256, delivery_id: 'fixture', path: 'fixture.epub', phase: 'ready' };
    if (o.action === 'begin-upload') return {};
    if (o.action === 'complete') return { phase: 'delivered', ...o.metadata };
  };
  const drive = async (op, args) => { if (op === 'upload') { uploads.push(args); return { id: 'new-file' }; } return f.drive(op, args); };
  const r = await deliver({ ...f, drive, run, options: { action: 'deliver', bookId: book.id } });
  assert.equal(r.phase, 'delivered'); assert.equal(uploads.length, 1);
  assert.equal(r.deduplication.absence_proven, false);
  assert.equal(r.deduplication.duplicate_upload_risk, true);
  assert.equal(actions.filter(a => a === 'fetch').length, 1);
});
test('strict mode still blocks unproven absence before downloading', async t => {
  const f = fixture(t, { 'search:': { results: [] }, 'list:': { files: [] } });
  const run = async o => { if (o.action === 'status') return { deliveries: [] }; if (o.action === 'search') return { books: [book] }; throw new Error('must not download'); };
  await assert.rejects(deliver({ ...f, run, options: { action: 'deliver', bookId: book.id, strictDriveDedup: true } }), { code: 'drive_listing_incomplete' });
});
test('raw connector normalization never invents complete coverage', () => {
  assert.equal(normalizeDrivePage({ structuredContent: { results: [] } }).complete, false);
  assert.equal(normalizeDrivePage({ files: [] }).complete, false);
  assert.equal(normalizeDrivePage({ files: [], complete: true, truncated: true }).complete, false);
  assert.equal(normalizeDrivePage({ files: [], complete: true }).complete, true);
  assert.throws(() => normalizeDrivePage({ isError: true }), { code: 'drive_connector_failed' });
  assert.throws(() => normalizeDrivePage({ files: [], next_page_token: 12 }), { code: 'drive_invalid_page' });
});
test('search arguments use exact escaped name and folder filters without document-only typing', () => {
  const args = searchArguments({ name: "Reader's Book.epub", folder: 'fixture-folder', page_token: 'opaque-provider-cursor' });
  assert.equal(args.item_type, undefined);
  assert.equal(args.query, undefined);
  assert.equal(args.page_token, 'opaque-provider-cursor');
  assert.ok(args.special_filter_query_str.includes("'fixture-folder' in parents"));
  assert.ok(args.special_filter_query_str.includes("name = 'Reader\\'s Book.epub'"));
});
test('a known receipt file ID bypasses discovery omissions but still checks bytes and privacy', async t => {
  const f = fixture(t);
  const run = async o => o.action === 'status' ? { deliveries: [{ ...target, book, sha256, phase: 'delivered', delivery_id: 'fixture', drive_id: 'fixture' }] } : { books: [book] };
  assert.equal((await deliver({ ...f, run, options: { action: 'deliver', bookId: book.id } })).reused, true);
  assert.deepEqual(f.calls.map(c => c.op), ['metadata', 'readback']);
});
test('unknown directory coverage never permits a retry of an uncertain upload', async t => {
  const f = fixture(t, { 'search:': { results: [] }, 'list:': { files: [] } });
  const run = async o => {
    if (o.action === 'status') return { deliveries: [{ ...target, book, sha256, phase: 'uploading' }] };
    if (o.action === 'search') return { books: [book] };
    throw new Error('must not retry');
  };
  await assert.rejects(deliver({ ...f, run, options: { action: 'deliver', bookId: book.id } }), { code: 'upload_outcome_uncertain' });
});
test('connector errors stop before download, including in compatibility mode', async t => {
  const f = fixture(t);
  const drive = async (op, args) => op === 'list' ? { isError: true } : f.drive(op, args);
  const run = async o => { if (o.action === 'status') return { deliveries: [] }; if (o.action === 'search') return { books: [book] }; throw new Error('must not download'); };
  await assert.rejects(deliver({ ...f, drive, run, options: { action: 'deliver', bookId: book.id } }), { code: 'drive_connector_failed' });
});
