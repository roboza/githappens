/**
 * Server-rendered HTML: sign-in pages, the invite landing page and the Cloud Patch web viewer.
 * Every page is self-contained (no external resources), uses a per-response CSP nonce for its
 * inline style/script, and escapes every interpolated value.
 */
import { randomBytes } from 'node:crypto';
import type { IdpId } from '@githappens/cloud-api/types';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
}

export const newNonce = (): string => randomBytes(16).toString('base64');

/** CSP for the sign-in pages: forms may post back here, and the final redirect goes to the loopback. */
export function authCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    "form-action 'self' http://127.0.0.1:* http://localhost:*",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function pageCsp(nonce: string, connectOrigins: string[] = []): string {
  return [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `connect-src 'self'${connectOrigins.map((o) => ` ${o}`).join('')}`,
    "img-src 'self' data:",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const STYLE = `
:root { color-scheme: light dark; --bg:#f7f7f8; --fg:#1d1d22; --muted:#666a73; --card:#fff; --line:#e2e3e8;
  --accent:#3b6cf6; --add:#e6f7ea; --addfg:#14632e; --del:#fdecec; --delfg:#8c1d1d; --hunk:#eef2ff; }
@media (prefers-color-scheme: dark) { :root { --bg:#141418; --fg:#e8e8ec; --muted:#9a9ea8; --card:#1d1d23;
  --line:#2c2d35; --accent:#7c9cff; --add:#14301d; --addfg:#9be3ad; --del:#3a1717; --delfg:#f3a7a7; --hunk:#1e2340; } }
* { box-sizing: border-box; }
body { margin:0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--fg); }
main { max-width: 980px; margin: 0 auto; padding: 32px 16px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:24px; }
.narrow { max-width: 420px; margin: 8vh auto 0; }
h1 { font-size: 20px; margin: 0 0 8px; }
p { margin: 8px 0; }
.muted { color: var(--muted); font-size: 13px; }
a.btn, button { display:block; width:100%; text-align:center; padding:10px 14px; margin:10px 0 0; border-radius:8px;
  border:1px solid var(--line); background:var(--card); color:var(--fg); font:inherit; text-decoration:none; cursor:pointer; }
a.btn.primary, button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
a.btn.inline { display:inline-block; width:auto; }
input { width:100%; padding:9px 10px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--fg); font:inherit; }
label { display:block; margin-top:12px; font-size:13px; color:var(--muted); }
table { width:100%; border-collapse: collapse; font-size: 13px; margin-top: 12px; }
td, th { text-align:left; padding:4px 8px; border-bottom:1px solid var(--line); }
td.num { text-align:right; font-variant-numeric: tabular-nums; white-space:nowrap; }
.add { color: var(--addfg); } .del { color: var(--delfg); }
pre { margin:16px 0 0; padding:0; border:1px solid var(--line); border-radius:8px; overflow:auto; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:var(--card); }
pre span { display:block; padding:0 12px; white-space:pre; min-height:1.45em; }
pre span.a { background:var(--add); color:var(--addfg); } pre span.d { background:var(--del); color:var(--delfg); }
pre span.h { background:var(--hunk); color:var(--muted); } pre span.f { font-weight:600; }
.row { display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
.err { color: var(--delfg); }
`;

function layout(title: string, nonce: string, body: string, script = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${STYLE}</style></head>
<body><main>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
}

const IDP_LABELS: Record<IdpId, string> = {
  github: 'Continue with GitHub',
  gitlab: 'Continue with GitLab',
  google: 'Continue with Google',
  email: 'Continue with email',
  dev: 'Development sign-in',
};

export function chooserPage(nonce: string, links: Array<{ idp: IdpId; href: string }>): string {
  const buttons = links
    .map((l) => `<a class="btn" href="${escapeHtml(l.href)}">${escapeHtml(IDP_LABELS[l.idp])}</a>`)
    .join('');
  return layout(
    'Sign in to GitHappens Cloud',
    nonce,
    `<div class="card narrow"><h1>Sign in to GitHappens Cloud</h1>
<p class="muted">Choose how you want to sign in. You will return to the GitHappens app afterwards.</p>${buttons}</div>`,
  );
}

export function emailFormPage(
  nonce: string,
  opts: { action: string; areq: string; hint?: string; dev: boolean; error?: string },
): string {
  const title = opts.dev ? 'Development sign-in' : 'Sign in with email';
  const intro = opts.dev
    ? 'This server runs with GH_CLOUD_DEV_LOGIN=1: any email address signs in immediately. Never enable this in production.'
    : 'We will email you a sign-in link. It works once and expires in 15 minutes.';
  return layout(
    title,
    nonce,
    `<div class="card narrow"><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(intro)}</p>
${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ''}
<form method="post" action="${escapeHtml(opts.action)}">
<input type="hidden" name="areq" value="${escapeHtml(opts.areq)}">
<label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email" value="${escapeHtml(opts.hint ?? '')}">
${opts.dev ? '<label for="name">Display name (optional)</label><input id="name" name="name" type="text" maxlength="100">' : ''}
<button class="primary" type="submit">${opts.dev ? 'Sign in' : 'Send sign-in link'}</button></form></div>`,
  );
}

export function messagePage(nonce: string, title: string, message: string, extra = ''): string {
  return layout(
    title,
    nonce,
    `<div class="card narrow"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${extra}</div>`,
  );
}

export function invitePage(nonce: string, orgName: string, deepLink: string): string {
  return layout(
    `Join ${orgName} on GitHappens`,
    nonce,
    `<div class="card narrow"><h1>Join ${escapeHtml(orgName)}</h1>
<p>You have been invited to the <strong>${escapeHtml(orgName)}</strong> organization on GitHappens Cloud.</p>
<a class="btn primary" href="${escapeHtml(deepLink)}">Open in GitHappens</a>
<p class="muted">Don't have the app yet? Install GitHappens, sign in to this server, then open this link again.</p></div>`,
  );
}

/**
 * Cloud Patch viewer. Fetches metadata + blob anonymously (link visibility), verifies sha256,
 * decrypts with the `#k=` fragment (never sent to the server) using the patch-crypto.ts format
 * ("KLP0" plain / "KLP1" iv|AES-256-GCM), gunzips with DecompressionStream and renders with
 * textContent only.
 */
export function viewerPage(nonce: string, patchId: string): string {
  const body = `<div class="card" id="app" data-id="${escapeHtml(patchId)}">
<div class="row"><h1 id="title">Cloud Patch</h1><a class="btn primary inline" id="open" href="githappens://patch/${escapeHtml(patchId)}">Open in GitHappens</a></div>
<p class="muted" id="meta"></p><p id="status" class="muted">Loading…</p>
<div id="files"></div><pre id="diff" hidden></pre></div>`;
  return layout('Cloud Patch · GitHappens', nonce, body, VIEWER_JS);
}

const VIEWER_JS = String.raw`
(async function () {
  'use strict';
  var app = document.getElementById('app');
  var id = app.getAttribute('data-id');
  var statusEl = document.getElementById('status');
  function status(msg, isErr) { statusEl.textContent = msg; statusEl.className = isErr ? 'err' : 'muted'; }
  var key = new URLSearchParams(location.hash.slice(1)).get('k') || '';
  if (key && !/^[A-Za-z0-9_-]{43}$/.test(key)) key = '';
  document.getElementById('open').href = 'githappens://patch/' + encodeURIComponent(id) + (key ? '#k=' + key : '');
  function b64urlBytes(s) {
    var b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    var out = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out;
  }
  async function gunzip(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  try {
    if (!window.crypto || !crypto.subtle || typeof DecompressionStream === 'undefined') {
      status('This browser cannot open Cloud Patches here (a secure https:// connection is required). Use "Open in GitHappens".', true);
      return;
    }
    var res = await fetch('/v1/patches/' + encodeURIComponent(id), { credentials: 'omit', cache: 'no-store' });
    if (res.status === 401 || res.status === 403) { status('This patch is only visible to members of its organization or invited collaborators. Use "Open in GitHappens" and sign in.', true); return; }
    if (res.status === 410) { status('This Cloud Patch has expired or was deleted.', true); return; }
    if (res.status === 404) { status('Cloud Patch not found.', true); return; }
    if (!res.ok) { status('Could not load the patch (HTTP ' + res.status + ').', true); return; }
    var meta = await res.json();
    document.getElementById('title').textContent = meta.title || 'Cloud Patch';
    document.title = (meta.title || 'Cloud Patch') + ' · GitHappens';
    var parts = [];
    if (meta.author && meta.author.name) parts.push('by ' + meta.author.name);
    if (meta.createdAt) parts.push(new Date(meta.createdAt).toLocaleString());
    if (meta.repo) parts.push(meta.repo.owner + '/' + meta.repo.name);
    if (meta.baseSha) parts.push('base ' + String(meta.baseSha).slice(0, 10));
    if (meta.expiresAt) parts.push('expires ' + new Date(meta.expiresAt).toLocaleDateString());
    document.getElementById('meta').textContent = parts.join(' · ');
    status('Downloading…');
    var blobRes = await fetch(meta.downloadUrl, { credentials: 'omit', cache: 'no-store' });
    if (!blobRes.ok) { status(blobRes.status === 410 ? 'This Cloud Patch has expired or was deleted.' : 'Could not download the patch (HTTP ' + blobRes.status + ').', true); return; }
    var bytes = new Uint8Array(await blobRes.arrayBuffer());
    var digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    var hex = Array.prototype.map.call(digest, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    if (hex !== meta.sha256) { status('The patch data is damaged (checksum mismatch).', true); return; }
    var magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    var zipped;
    if (magic === 'KLP0') {
      zipped = bytes.subarray(4);
    } else if (magic === 'KLP1') {
      if (!key) { status('This patch is encrypted; ask for the full link (it ends with #k=…).', true); return; }
      try {
        var k = await crypto.subtle.importKey('raw', b64urlBytes(key), 'AES-GCM', false, ['decrypt']);
        zipped = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(4, 16) }, k, bytes.subarray(16)));
      } catch (e) { status('The link key does not decrypt this patch.', true); return; }
    } else { status('Unknown patch format.', true); return; }
    var bundle;
    try { bundle = JSON.parse(new TextDecoder().decode(await gunzip(zipped))); } catch (e) { status('The patch data is damaged.', true); return; }
    if (!bundle || bundle.format !== 'githappens-patch/1') { status('Unsupported patch format.', true); return; }
    if (bundle.title) { document.getElementById('title').textContent = bundle.title; document.title = bundle.title + ' · GitHappens'; }
    var files = Array.isArray(bundle.files) ? bundle.files : [];
    var table = el('table'); var head = el('tr');
    ['Status', 'File', '+', '−'].forEach(function (h) { head.appendChild(el('th', h)); });
    table.appendChild(head);
    files.forEach(function (f) {
      var tr = el('tr');
      tr.appendChild(el('td', String(f.status || '')));
      tr.appendChild(el('td', String(f.path || '') + (f.binary ? ' (binary)' : '')));
      tr.appendChild(el('td', String(f.additions | 0), 'num add'));
      tr.appendChild(el('td', String(f.deletions | 0), 'num del'));
      table.appendChild(tr);
    });
    document.getElementById('files').appendChild(table);
    var pre = document.getElementById('diff');
    var lines = String(bundle.patch || '').split('\n');
    var MAX = 20000;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < Math.min(lines.length, MAX); i++) {
      var l = lines[i];
      var cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') ? 'f'
        : l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : '';
      frag.appendChild(el('span', l, cls));
    }
    pre.appendChild(frag);
    pre.hidden = false;
    status(files.length + ' file(s)' + (lines.length > MAX ? ' · showing the first ' + MAX + ' lines; open in GitHappens for the full patch' : ''));
  } catch (e) {
    status('Could not open the patch.', true);
  }
})();
`;
