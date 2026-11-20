// Provider-neutral orchestration over the existing host connector, not a Drive API.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const text = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function privateMetadata(m, target) {
  const name = m.name ?? m.title, url = m.webViewLink ?? m.url;
  if (!m.id || name !== target.name || (m.mimeType ?? m.mime_type) !== 'application/epub+zip' ||
      !/^\d+$/.test(String(m.size)) || Number(m.size) <= 0 || m.trashed === true || m.shared !== false ||
      m.permissions?.length !== 1 || m.permissions[0].type !== 'user' || m.permissions[0].role !== 'owner') fail('drive_candidate_not_private_or_matching');
  let u;
  try { u = new URL(url); } catch { fail('drive_invalid_link'); }
  if (u.origin !== 'https://drive.google.com' || u.pathname !== `/file/d/${m.id}/view` || u.username || u.password || u.hash ||
      [...u.searchParams.keys()].some(k => k !== 'usp')) fail('drive_invalid_link');
  if (target.size !== undefined && Number(m.size) !== Number(target.size)) fail('drive_size_mismatch');
  return { id: m.id, name, size: Number(m.size), url, shared: false, permissions: [{ type: 'user', role: 'owner' }] };
}
async function pages(drive, operation, target) {
  const files = [], seen = new Set();
  let pageToken;
  do {
    const page = await drive(operation, { name: target.name, folder: target.folder ?? 'root', page_token: pageToken });
    if (!Array.isArray(page.files)) fail('drive_invalid_page');
    files.push(...page.files);
    pageToken = page.next_page_token || undefined;
    if (pageToken && (typeof pageToken !== 'string' || seen.has(pageToken))) fail('drive_pagination_loop');
    if (pageToken) seen.add(pageToken);
    else if (page.complete !== true && operation === 'list') fail('drive_listing_incomplete');
    if (!pageToken) return { files, complete: page.complete === true };
  } while (pageToken);
}
export async function reconcileDrive({ drive, target, validateEpub, readMetadata }) {
  // A search miss is never evidence of absence. Read the entire destination.
  const search = await pages(drive, 'search', target);
  let files = search.files;
  if (!search.complete || !files.some(m => (m.name ?? m.title) === target.name)) {
    files = [...files, ...(await pages(drive, 'list', target)).files];
  }
  const candidates = [...new Map(files.filter(m => (m.name ?? m.title) === target.name).map(m => [m.id, m])).values()];
  let result;
  for (const candidate of candidates) {
    const m = privateMetadata(await drive('metadata', { id: candidate.id }), target);
    if (m.id !== candidate.id) fail('drive_candidate_id_mismatch');
    const raw = await drive('readback', { id: m.id, url: m.url });
    // Host materializes only the selected EPUB into temporary storage.
    if (typeof raw.path !== 'string') fail('drive_readback_missing');
    try {
      if (fs.lstatSync(raw.path).isSymbolicLink()) fail('drive_readback_invalid');
      const bytes = fs.readFileSync(raw.path);
      if (bytes.length !== m.size) fail('drive_size_mismatch');
      validateEpub(raw.path);
      const sha256 = hash(bytes);
      if (target.sha256 && target.sha256 !== sha256) fail('drive_content_mismatch');
      const book = await readMetadata(raw.path);
      if (text(book.title) !== text(target.book.name) ||
          !book.authors?.some(a => target.book.authors?.some(b => text(a) === text(b))) ||
          !book.languages?.some(l => text(l) === text(target.book.language) || (l === 'en' && target.book.language === 'English'))) fail('drive_book_identity_uncertain');
      // With no prior byte hash, require an unambiguous source/edition as well.
      if (!target.sha256 && (!text(target.book.publisher) || text(book.publisher) !== text(target.book.publisher))) fail('drive_edition_uncertain');
      if (result && result.sha256 !== sha256) fail('drive_conflicting_duplicates');
      result = { ...m, sha256, phase: 'delivered', reused: true };
    } finally { fs.rmSync(raw.path, { force: true }); }
  }
  return result ?? null;
}

export async function deliver({ run, options, drive, validateEpub, readMetadata }) {
  const state = (await run({ action: 'status' })).deliveries.find(s => s.book?.id === options.bookId || s.delivery_id === options.delivery);
  const search = await run({ ...options, action: 'search' });
  const book = search.books.find(b => b.id === options.bookId);
  if (!book?.delivery_name) fail('selection_not_in_results');
  if (state?.phase === 'delivered') {
    // Receipts are hints, never proof that a Drive file still exists/private.
    const found = await reconcileDrive({ drive, target: { ...state, book }, validateEpub, readMetadata });
    if (!found) fail('drive_prior_delivery_missing');
    return found;
  }
  const target = { name: book.delivery_name, book, ...state };
  const check = () => reconcileDrive({ drive, target, validateEpub, readMetadata });
  let found = await check();
  if (found) {
    if (state && ['ready', 'uploading'].includes(state.phase)) await run({ action: 'complete', delivery: state.delivery_id, metadata: found });
    return found;
  }
  if (state?.phase === 'uploading') fail('upload_outcome_uncertain');
  if (state?.phase === 'uncertain') fail('download_outcome_uncertain');
  const artifact = state ?? await run({ ...options, action: 'fetch' });
  if (options.action === 'fetch') return artifact;
  Object.assign(target, artifact);
  found = await check(); // Recheck immediately before upload, using exact bytes.
  if (found) { await run({ action: 'complete', delivery: artifact.delivery_id, metadata: found }); return found; }
  await run({ action: 'begin-upload', delivery: artifact.delivery_id });
  // Never retry here. Lost responses leave the durable uploading state intact.
  const uploaded = await drive('upload', { path: artifact.path, name: artifact.name, mime_type: 'application/epub+zip' });
  const metadata = privateMetadata(await drive('metadata', { id: uploaded.id }), target);
  return await run({ action: 'complete', delivery: artifact.delivery_id, metadata });
}

export function connectorBridge() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let sequence = 0;
  return {
    close: () => lines.close(),
    drive: async (operation, args) => {
      const request_id = ++sequence;
      fs.writeSync(1, JSON.stringify({ connector_request: true, request_id, operation, arguments: args }) + '\n');
      const line = await iterator.next();
      if (line.done) fail('drive_connector_required');
      let reply;
      try { reply = JSON.parse(line.value); } catch { fail('drive_invalid_reply'); }
      if (reply.request_id !== request_id || reply.error || !reply.result) fail('drive_connector_failed');
      return reply.result;
    },
  };
}
