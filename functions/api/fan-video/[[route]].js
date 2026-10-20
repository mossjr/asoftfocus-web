/**
 * A Soft Focus — fan video submissions API (Cloudflare Pages Function)
 *
 *   GET  /api/fan-video/config     -> limits, Turnstile site key, mode
 *   POST /api/fan-video/start      -> validate form + Turnstile, open a multipart upload
 *   PUT  /api/fan-video/part?n=N   -> upload one chunk (header X-Upload-Token)
 *   POST /api/fan-video/complete   -> stitch chunks together, write sidecar JSON, notify
 *   POST /api/fan-video/abort      -> cancel an upload
 *
 * The browser sends the video in 10 MiB chunks through this function into R2
 * (each chunk is well under Cloudflare's 100 MB request limit). Chunks are
 * retried individually, so a dropped connection only re-sends one chunk.
 *
 * Bindings / settings (Pages project → Settings):
 *   FAN_VIDEOS              R2 bucket binding (e.g. bucket "asoftfocus-fan-videos")
 *   TURNSTILE_SITE_KEY      Turnstile widget site key (public)
 *   TURNSTILE_SECRET_KEY    Turnstile secret (secret)
 *   UPLOAD_SIGNING_SECRET   random 32+ char string (secret)
 *   FAN_VIDEO_UPLOADS_OPEN  "true" to accept uploads on the production domain
 *   NOTIFY_WEBHOOK_URL      optional: Google Apps Script web-app URL that emails bookings@
 *   NOTIFY_WEBHOOK_SECRET   optional: shared secret checked by that script
 *
 * Safety: on asoftfocus.com nothing is accepted unless the bucket, both secrets and
 * FAN_VIDEO_UPLOADS_OPEN=true are all set. On *.asoftfocus.pages.dev previews and
 * localhost it falls back to Cloudflare's Turnstile TEST keys, and if no bucket is
 * bound it runs in DEMO mode: chunks are received, counted and thrown away.
 */

const MAX_BYTES = 4 * 1024 * 1024 * 1024;        // 4 GiB per video
const PART_SIZE = 10 * 1024 * 1024;              // 10 MiB chunks (R2 minimum is 5 MiB)
const TOKEN_TTL_SECONDS = 6 * 24 * 60 * 60;      // R2 drops unfinished multipart uploads after 7 days
const CONSENT_VERSION = 'DRAFT-2026-10-21';      // bump when Kyle approves final wording
const ALLOWED_EXT = ['mov', 'mp4', 'm4v', '3gp', 'webm'];

// Cloudflare's documented Turnstile test keys (always pass). Preview/localhost only.
const TEST_SITE_KEY = '1x00000000000000000000AA';
const TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';
const PREVIEW_SIGNING_SECRET = 'preview-only-not-for-production-asf-fan-video';

// ---------------------------------------------------------------- helpers

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const fail = (status, error, extra = {}) => json({ ok: false, error, ...extra }, status);

function isPreviewHost(host) {
  host = (host || '').toLowerCase().split(':')[0];
  return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.asoftfocus.pages.dev');
}

function settings(env, request) {
  const preview = isPreviewHost(new URL(request.url).hostname);
  const bucket = env.FAN_VIDEOS || null;
  const siteKey = env.TURNSTILE_SITE_KEY || (preview ? TEST_SITE_KEY : null);
  const turnstileSecret = env.TURNSTILE_SECRET_KEY || (preview ? TEST_SECRET_KEY : null);
  const signingSecret = env.UPLOAD_SIGNING_SECRET || (preview ? PREVIEW_SIGNING_SECRET : null);
  let mode;
  let open;
  if (preview) {
    mode = bucket ? 'preview-storage' : 'demo';
    open = true;
  } else {
    mode = 'live';
    open = Boolean(bucket && siteKey && turnstileSecret && signingSecret && env.FAN_VIDEO_UPLOADS_OPEN === 'true');
  }
  return { preview, bucket, siteKey, turnstileSecret, signingSecret, mode, open };
}

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signToken(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

async function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(sig), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function sha256Hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function slug(text, max = 40) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

const clean = (v, max) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

function brisbaneDate(d = new Date()) {
  // YYYY-MM-DD in Australia/Brisbane (UTC+10, no daylight saving)
  return new Date(d.getTime() + 10 * 3600 * 1000).toISOString().slice(0, 10);
}

function partCountFor(size) {
  return Math.max(1, Math.ceil(size / PART_SIZE));
}
function expectedPartSize(size, n, count) {
  return n < count ? PART_SIZE : size - PART_SIZE * (count - 1);
}

// MP4/MOV/M4V/3GP have an "ftyp" box at byte 4; WebM starts with the EBML magic 1A 45 DF A3.
function looksLikeVideo(bytes) {
  if (bytes.length < 12) return false;
  const ftyp = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (ftyp === 'ftyp') return true;
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true;
  // Some QuickTime files start with a 'wide', 'free', 'mdat' or 'moov' atom instead.
  return ['wide', 'free', 'mdat', 'moov', 'skip', 'pnot'].includes(ftyp);
}

// ---------------------------------------------------------------- validation

function validateSubmission(body) {
  const errors = {};
  const name = clean(body.name, 80);
  if (name.length < 2) errors.name = 'Please tell us your name.';

  let instagram = clean(body.instagram, 120)
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/^@/, '');
  if (instagram && !/^[A-Za-z0-9._]{1,30}$/.test(instagram)) errors.instagram = 'That doesn’t look like an Instagram handle (letters, numbers, dots and underscores only).';

  let facebook = clean(body.facebook, 120)
    .replace(/^https?:\/\/(www\.|m\.)?facebook\.com\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/$/, '')
    .replace(/^@/, '');
  if (facebook && !/^[\p{L}\p{N} .'_\-]{1,80}$/u.test(facebook)) errors.facebook = 'Please enter just your Facebook name or profile name.';

  const email = clean(body.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'Please check your email address (or leave it blank).';

  // Gig: an id like 2026-10-24-8-bit-bar from the dropdown, or "other" with venue + date.
  const gigId = clean(body.gigId, 100).toLowerCase();
  let gigFolder = '';
  let gigLabel = clean(body.gigLabel, 140);
  let otherVenue = '';
  let otherDate = '';
  if (gigId === 'other') {
    otherVenue = clean(body.otherVenue, 80);
    otherDate = clean(body.otherDate, 10);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(otherDate) ? new Date(`${otherDate}T00:00:00+10:00`) : null;
    if (otherVenue.length < 2) errors.otherVenue = 'Which venue or event was it?';
    if (!d || isNaN(d)) errors.otherDate = 'Roughly what date was the gig?';
    else if (d.getTime() > Date.now() + 36 * 3600 * 1000) errors.otherDate = 'That date is in the future.';
    else if (d.getTime() < Date.now() - 3 * 365 * 24 * 3600 * 1000) errors.otherDate = 'That date is a bit too far back.';
    if (!errors.otherVenue && !errors.otherDate) {
      gigFolder = `${otherDate}_${slug(otherVenue, 40) || 'venue'}`;
      gigLabel = `${otherVenue} (${otherDate}) [entered by fan]`;
    }
  } else {
    const m = /^(\d{4}-\d{2}-\d{2})-([a-z0-9-]{1,60})$/.exec(gigId);
    if (!m) errors.gigId = 'Please choose which gig you filmed.';
    else gigFolder = `${m[1]}_${m[2]}`;
  }

  if (body.consent !== true) errors.consent = 'Please tick the box so we can use and tag your video.';

  const file = body.file || {};
  const fileName = clean(file.name, 200);
  const size = Number(file.size);
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const type = clean(file.type, 80).toLowerCase();
  if (!Number.isFinite(size) || size <= 0) errors.file = 'Please choose a video file.';
  else if (size > MAX_BYTES) errors.file = 'That video is over 4 GB. Please trim it a little or send it in two parts.';
  else if (!(type.startsWith('video/') || ALLOWED_EXT.includes(ext))) errors.file = 'That file doesn’t look like a video (we accept .mov, .mp4, .m4v, .3gp and .webm).';

  return {
    errors,
    data: {
      name, instagram, facebook, email, gigId, gigFolder, gigLabel, otherVenue, otherDate,
      file: { name: fileName, size, type: type || 'application/octet-stream', ext: ALLOWED_EXT.includes(ext) ? ext : (type.includes('quicktime') ? 'mov' : 'mp4') },
      consentVersion: clean(body.consentVersion, 40) || CONSENT_VERSION,
    },
  };
}

async function verifyTurnstile(token, secret, ip) {
  if (!token) return { success: false, 'error-codes': ['missing-input-response'] };
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  return r.json();
}

// ---------------------------------------------------------------- notification

async function notify(env, submission, mode) {
  if (!env.NOTIFY_WEBHOOK_URL) return;
  const handles = [
    submission.instagram && `Instagram: @${submission.instagram}`,
    submission.facebook && `Facebook: ${submission.facebook}`,
  ].filter(Boolean).join('\n') || 'No social handle given';
  const mb = (submission.file.size / 1024 / 1024).toFixed(0);
  const subject = `${mode === 'live' ? '' : '[PREVIEW] '}New fan video: ${submission.gigLabel || submission.gigFolder} — ${submission.name}`;
  const text = [
    `${submission.name} sent a video (${mb} MB) via asoftfocus.com.`,
    '',
    `Gig: ${submission.gigLabel || submission.gigFolder}`,
    handles,
    submission.email ? `Email: ${submission.email}` : 'Email: not given',
    `Consent ticked: yes (${submission.consentVersion}) at ${submission.submittedAt}`,
    '',
    `Stored at: ${submission.key}`,
    'It will appear in the Google Drive "A Soft Focus — Fan Videos" folder after the next sync.',
  ].join('\n');
  try {
    await fetch(env.NOTIFY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.NOTIFY_WEBHOOK_SECRET || '', subject, text, submission }),
    });
  } catch (e) {
    console.log('notify failed', e && e.message);
  }
}

// ---------------------------------------------------------------- handlers

async function handleConfig(cfg) {
  return json({
    ok: true,
    open: cfg.open,
    mode: cfg.mode,
    siteKey: cfg.open ? cfg.siteKey : null,
    maxBytes: MAX_BYTES,
    partSize: PART_SIZE,
    consentVersion: CONSENT_VERSION,
  });
}

async function handleStart(request, env, cfg) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Bad request.');
  }
  // Honeypot: real people never see or fill the "website" field.
  if (clean(body.website, 200)) return fail(400, 'Something went wrong. Please try again.');

  const { errors, data } = validateSubmission(body);
  if (Object.keys(errors).length) return fail(400, 'Please check the highlighted fields.', { fields: errors });

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ts = await verifyTurnstile(body.turnstileToken, cfg.turnstileSecret, ip);
  if (!ts.success) return fail(403, 'We couldn’t confirm you’re human. Please tick the check again and resubmit.', { turnstile: ts['error-codes'] || [] });

  const submissionId = crypto.randomUUID();
  const today = brisbaneDate();
  const who = [slug(data.name, 30) || 'fan', data.instagram && `ig-${slug(data.instagram, 30)}`, !data.instagram && data.facebook && `fb-${slug(data.facebook, 30)}`]
    .filter(Boolean)
    .join('_');
  const key = `inbox/${data.gigFolder}/${today}_${who}_${submissionId.slice(0, 6)}.${data.file.ext}`;
  const partCount = partCountFor(data.file.size);

  const sidecar = {
    submissionId,
    status: 'uploading',
    key,
    submittedAt: new Date().toISOString(),
    name: data.name,
    instagram: data.instagram,
    facebook: data.facebook,
    email: data.email,
    gigId: data.gigId,
    gigFolder: data.gigFolder,
    gigLabel: data.gigLabel,
    otherVenue: data.otherVenue,
    otherDate: data.otherDate,
    consent: true,
    consentVersion: data.consentVersion,
    file: { originalName: data.file.name, size: data.file.size, type: data.file.type },
    technical: {
      country: (request.cf && request.cf.country) || null,
      ipHash: ip ? (await sha256Hex(`${cfg.signingSecret}|${ip}`)).slice(0, 16) : null,
      userAgent: clean(request.headers.get('user-agent'), 200),
    },
    mode: cfg.mode,
  };

  let uploadId;
  if (cfg.bucket) {
    const mpu = await cfg.bucket.createMultipartUpload(key, {
      httpMetadata: { contentType: data.file.type },
      customMetadata: { submissionId },
    });
    uploadId = mpu.uploadId;
    await cfg.bucket.put(`${key}.json`, JSON.stringify(sidecar, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    });
  } else {
    uploadId = `demo-${submissionId}`;
  }

  const token = await signToken(
    { k: key, u: uploadId, s: data.file.size, p: partCount, id: submissionId, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS },
    cfg.signingSecret,
  );

  return json({ ok: true, mode: cfg.mode, submissionId, key, uploadId, token, partSize: PART_SIZE, partCount });
}

async function readAll(stream, limit) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      reader.cancel();
      throw new Error('too-large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function handlePart(request, cfg) {
  const t = await verifyToken(request.headers.get('X-Upload-Token'), cfg.signingSecret);
  if (!t) return fail(403, 'This upload has expired. Please start again.', { expired: true });
  const n = Number(new URL(request.url).searchParams.get('n'));
  if (!Number.isInteger(n) || n < 1 || n > t.p) return fail(400, 'Bad chunk number.');
  const expected = expectedPartSize(t.s, n, t.p);
  if (Number(request.headers.get('content-length')) !== expected) return fail(400, 'Chunk size mismatch.');
  if (!request.body) return fail(400, 'Empty chunk.');

  let data;
  try {
    data = await readAll(request.body, expected);
  } catch {
    return fail(413, 'Chunk too large.');
  }
  if (data.byteLength !== expected) return fail(400, 'Chunk was cut short. Retrying…', { retry: true });
  if (n === 1 && !looksLikeVideo(data)) return fail(415, 'That file doesn’t look like a video.', { notVideo: true });

  if (!cfg.bucket) return json({ ok: true, partNumber: n, etag: `demo-${n}-${data.byteLength}` });

  const mpu = cfg.bucket.resumeMultipartUpload(t.k, t.u);
  const part = await mpu.uploadPart(n, data);
  return json({ ok: true, partNumber: part.partNumber, etag: part.etag });
}

async function handleComplete(request, env, cfg, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Bad request.');
  }
  const t = await verifyToken(body.token, cfg.signingSecret);
  if (!t) return fail(403, 'This upload has expired. Please start again.', { expired: true });
  const parts = Array.isArray(body.parts) ? body.parts : [];
  const seen = new Set();
  const cleanParts = parts
    .map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag || '') }))
    .filter((p) => Number.isInteger(p.partNumber) && p.partNumber >= 1 && p.partNumber <= t.p && p.etag && !seen.has(p.partNumber) && seen.add(p.partNumber))
    .sort((a, b) => a.partNumber - b.partNumber);
  if (cleanParts.length !== t.p) return fail(400, 'Some chunks are missing.', { missing: true });

  let sidecar = {
    submissionId: t.id, key: t.k, submittedAt: new Date().toISOString(), mode: cfg.mode,
    name: '(demo)', gigFolder: t.k.split('/')[1], gigLabel: '', file: { size: t.s },
    consentVersion: CONSENT_VERSION,
  };

  if (cfg.bucket) {
    const mpu = cfg.bucket.resumeMultipartUpload(t.k, t.u);
    let obj;
    try {
      obj = await mpu.complete(cleanParts);
    } catch (e) {
      // Already completed (e.g. the phone retried after a dropped response)?
      const head = await cfg.bucket.head(t.k);
      if (!head) return fail(500, 'We couldn’t finish saving the video. Please try again.', { detail: String(e && e.message) });
      obj = head;
    }
    if (obj.size !== t.s) {
      await cfg.bucket.delete([t.k, `${t.k}.json`]);
      return fail(400, 'The upload didn’t match the original file size. Please try again.');
    }
    const existing = await cfg.bucket.get(`${t.k}.json`);
    if (existing) sidecar = await existing.json();
    // Phone retried "complete" after a dropped response: already recorded and notified.
    if (sidecar.status === 'received') return json({ ok: true, mode: cfg.mode, submissionId: t.id, repeat: true });
    sidecar.status = 'received';
    sidecar.completedAt = new Date().toISOString();
    sidecar.storedSize = obj.size;
    sidecar.etag = obj.etag || obj.httpEtag || null;
    await cfg.bucket.put(`${t.k}.json`, JSON.stringify(sidecar, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    });
  } else {
    sidecar.status = 'demo-discarded';
  }

  ctx.waitUntil(notify(env, sidecar, cfg.mode));
  return json({ ok: true, mode: cfg.mode, submissionId: t.id });
}

async function handleAbort(request, cfg) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Bad request.');
  }
  const t = await verifyToken(body.token, cfg.signingSecret);
  if (!t) return json({ ok: true });
  if (cfg.bucket) {
    try {
      await cfg.bucket.resumeMultipartUpload(t.k, t.u).abort();
    } catch {}
    await cfg.bucket.delete(`${t.k}.json`);
  }
  return json({ ok: true });
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const route = Array.isArray(params.route) ? params.route.join('/') : params.route || '';
  const cfg = settings(env, request);
  const method = request.method.toUpperCase();

  try {
    if (route === 'config' && method === 'GET') return handleConfig(cfg);
    if (!cfg.open) return fail(503, 'Video submissions aren’t open yet. Please check back soon.');
    if (route === 'start' && method === 'POST') return await handleStart(request, env, cfg);
    if (route === 'part' && method === 'PUT') return await handlePart(request, cfg);
    if (route === 'complete' && method === 'POST') return await handleComplete(request, env, cfg, context);
    if (route === 'abort' && method === 'POST') return await handleAbort(request, cfg);
    return fail(404, 'Not found.');
  } catch (e) {
    console.log('fan-video error', route, e && e.stack);
    return fail(500, 'Something went wrong on our side. Please try again in a moment.', { retry: true });
  }
}
