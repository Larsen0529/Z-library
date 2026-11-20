// Provider-neutral orchestration over the existing host connector, not a Drive API.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const text = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const quote = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
export function searchArguments({ name, folder = 'root', page_token }) {
  // No item_type: the current document-only surface omits EPUB binaries.
  return { best_effort_fetch: false, topn: 100,
    special_filter_query_str: `trashed = false and 'me' in owners and ${quote(folder)} in parents and name = ${quote(name)}`,
    ...(page_token ? { page_token } : {}),
  };
}
export function normalizeDrivePage(raw) {
  if (raw?.isError || raw?.error) fail('drive_connector_failed');
  const page = raw?.structuredContent ?? raw;
  const files = page?.files ?? page?.results;
  if (!Array.isArray(files)) fail('drive_invalid_page');
  const next_page_token = page.next_page_token ?? page.nextPageToken;
  if (next_page_token != null && typeof next_page_token !== 'string') fail('drive_invalid_page');
  // Missing provider markers remain unknown, even when fewer than top_k return.
  return { files, next_page_token: next_page_token || undefined, complete: page.complete === true && page.truncated !== true && page.has_more !== true };
}
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
    const args = { name: target.name, folder: target.folder ?? 'root', page_token: pageToken };
    args.tool_arguments = operation === 'search' ? searchArguments(args) : {
      url: args.folder === 'root' ? 'root' : `https://drive.google.com/drive/folders/${args.folder}`, top_k: 1000,
    };
    const page = normalizeDrivePage(await drive(operation, args));
    files.push(...page.files);
    pageToken = page.next_page_token || undefined;
    if (pageToken && (typeof pageToken !== 'string' || seen.has(pageToken))) fail('drive_pagination_loop');
    if (pageToken) seen.add(pageToken);
    if (!pageToken) return { files, complete: page.complete === true };
  } while (pageToken);
}
export async function reconcileDrive({ drive, target, validateEpub, readMetadata }) {
  // Positive identity can be proved without proving that discovery was complete.
  let files, search, listing;
  if (target.drive_id) files = [{ id: target.drive_id, name: target.name }];
  else {
    search = await pages(drive, 'search', target);
    files = search.files;
    if (!search.complete || !files.some(m => (m.name ?? m.title) === target.name)) {
      listing = await pages(drive, 'list', target);
      files = [...files, ...listing.files];
    }
  }
  const deduplication = { search_complete: search?.complete === true,
    folder_checked: Boolean(listing), folder_complete: listing?.complete === true,
    absence_proven: false, duplicate_upload_risk: false };
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
      result = { ...m, sha256, phase: 'delivered', reused: true, deduplication };
    } finally { fs.rmSync(raw.path, { force: true }); }
  }
  if (result) return result;
  deduplication.absence_proven = listing?.complete === true;
  deduplication.duplicate_upload_risk = !deduplication.absence_proven;
  return { phase: 'not_observed', reused: false, deduplication };
}

export async function deliver({ run, options, drive, validateEpub, readMetadata }) {
  if (!/^[\w-]+:[\w-]+$/.test(options.bookId ?? '')) fail('selection_not_in_results');
  const state = (await run({ action: 'status' })).deliveries.find(s => s.book?.id === options.bookId || s.delivery_id === options.delivery);
  // A retained selection/hash need not depend on a changing source search page.
  const book = state?.book ?? (await run({ ...options, action: 'search' })).books.find(b => b.id === options.bookId);
  if (book?.id !== options.bookId) fail('selection_not_in_results');
  if (!book?.delivery_name) fail('selection_not_in_results');
  if (state?.phase === 'delivered') {
    // Receipts are hints, never proof that a Drive file still exists/private.
    const found = await reconcileDrive({ drive, target: { ...state, book }, validateEpub, readMetadata });
    if (!found.reused) fail('drive_prior_delivery_missing');
    return found;
  }
  const target = { name: book.delivery_name, book, ...state };
  const check = () => reconcileDrive({ drive, target, validateEpub, readMetadata });
  let found = await check();
  if (found.reused) {
    if (state && ['ready', 'uploading'].includes(state.phase)) await run({ action: 'complete', delivery: state.delivery_id, metadata: found });
    return found;
  }
  if (state?.phase === 'uploading') fail('upload_outcome_uncertain');
  if (state?.phase === 'uncertain') fail('download_outcome_uncertain');
  const requireCoverage = finding => {
    if (!finding.deduplication.absence_proven && options.strictDriveDedup) fail('drive_listing_incomplete');
    if (!finding.deduplication.absence_proven) fs.writeSync(2, JSON.stringify({ warning: 'drive_absence_unproven',
      message: 'No matching file observed; directory coverage is incomplete. A hidden existing file could cause a duplicate upload.' }) + '\n');
  };
  requireCoverage(found);
  const artifact = state ?? await run({ ...options, action: 'fetch' });
  if (options.action === 'fetch') return { ...artifact, deduplication: found.deduplication };
  Object.assign(target, artifact);
  found = await check(); // Recheck immediately before upload, using exact bytes.
  if (found.reused) { await run({ action: 'complete', delivery: artifact.delivery_id, metadata: found }); return found; }
  requireCoverage(found);
  await run({ action: 'begin-upload', delivery: artifact.delivery_id, deduplication: found.deduplication });
  // Never retry here. Lost responses leave the durable uploading state intact.
  const uploaded = await drive('upload', { path: artifact.path, name: artifact.name, mime_type: 'application/epub+zip' });
  const metadata = privateMetadata(await drive('metadata', { id: uploaded.id }), target);
  if (metadata.id !== uploaded.id) fail('drive_candidate_id_mismatch');
  return { ...await run({ action: 'complete', delivery: artifact.delivery_id, metadata }), deduplication: found.deduplication };
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
