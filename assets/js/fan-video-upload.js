/* A Soft Focus — fan video upload (submit-video.html)
 *
 * Sends the video in 10 MiB chunks to /api/fan-video/part (3 at a time).
 * - Each chunk retries on its own with back-off; if the phone goes offline we wait
 *   for the connection to come back and carry on.
 * - Progress is remembered in localStorage, so if the page is closed or reloaded the
 *   fan can pick the same video again and it resumes where it stopped (up to 6 days).
 * - Keeps the screen awake while uploading (Wake Lock API, where supported).
 */
(function () {
  'use strict';

  const API = '/api/fan-video';
  const CONCURRENCY = 3;
  const MAX_TRIES_ONLINE = 8;
  const RESUME_PREFIX = 'asf-fan-video:';
  const GIG_WINDOW_DAYS = 120;

  const $ = (sel) => document.querySelector(sel);
  const form = $('#fanVideoForm');
  if (!form) return;

  const els = {
    banner: $('#previewBanner'),
    closed: $('#uploadsClosed'),
    gig: $('#gigId'),
    otherWrap: $('#otherGigFields'),
    file: $('#videoFile'),
    fileLabel: $('#fileChosen'),
    submit: $('#submitBtn'),
    formError: $('#formError'),
    progressPanel: $('#progressPanel'),
    bar: $('#progressBar'),
    barFill: $('#progressFill'),
    pct: $('#progressPct'),
    detail: $('#progressDetail'),
    status: $('#progressStatus'),
    pauseBtn: $('#pauseBtn'),
    cancelBtn: $('#cancelBtn'),
    success: $('#successPanel'),
    successMode: $('#successMode'),
    another: $('#anotherBtn'),
    consentVersion: $('#consentVersion'),
  };

  let config = null;
  let turnstileWidgetId = null;
  let job = null; // current upload
  let wakeLock = null;

  // ------------------------------------------------------------ formatting
  function fmtBytes(n) {
    if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
    if (n >= 1024 ** 2) return Math.round(n / 1024 ** 2) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }
  function fmtTime(sec) {
    if (!isFinite(sec) || sec <= 0) return '';
    if (sec < 60) return 'under a minute left';
    const m = Math.round(sec / 60);
    return m < 60 ? `about ${m} min left` : `about ${Math.floor(m / 60)} h ${m % 60} min left`;
  }
  function slug(t) {
    return String(t || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  }

  // ------------------------------------------------------------ gigs dropdown
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  function brisbaneISO(d) {
    return new Date(d.getTime() + 10 * 3600 * 1000).toISOString().slice(0, 10);
  }
  function labelFor(iso, venue) {
    const d = new Date(iso + 'T12:00:00+10:00');
    const day = d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Brisbane' });
    return `${day} — ${venue}`;
  }

  async function loadGigs() {
    const preselect = new URLSearchParams(location.search).get('gig');
    let data = null;
    try {
      const r = await fetch('/gigs-data.json', { cache: 'no-cache' });
      data = await r.json();
    } catch (e) { /* fall through to "Other" only */ }

    const now = Date.now();
    const oldest = now - GIG_WINDOW_DAYS * 86400 * 1000;
    const gigs = new Map();

    (data && data.upcomingGigs || []).forEach((g) => {
      const start = Date.parse(g.start);
      // Include a gig once it is within 12 h of starting (so tonight's gig is listed during the show).
      if (!isFinite(start) || start > now + 12 * 3600 * 1000 || start < oldest) return;
      const iso = brisbaneISO(new Date(start));
      gigs.set(g.id, { id: g.id, iso, label: labelFor(iso, `${g.venueName}${g.town ? ', ' + g.town : ''}`) });
    });

    (data && data.upcomingAndRecentGigs || []).forEach((g) => {
      const m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(String(g.date || '').trim());
      if (!m || !(m[2].toLowerCase() in MONTHS)) return; // skip non-gig entries like "Oct 2026" magazine
      const d = new Date(Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1], 2));
      if (d.getTime() < oldest || d.getTime() > now + 12 * 3600 * 1000) return;
      const iso = d.toISOString().slice(0, 10);
      const venueShort = String(g.venue || '').split(' — ')[0];
      const id = `${iso}-${slug(venueShort)}`;
      if ([...gigs.values()].some((x) => x.iso === iso)) return; // already listed from upcomingGigs
      gigs.set(id, { id, iso, label: labelFor(iso, g.venue) });
    });

    const sorted = [...gigs.values()].sort((a, b) => b.iso.localeCompare(a.iso));
    const frag = document.createDocumentFragment();
    sorted.forEach((g) => {
      const o = document.createElement('option');
      o.value = g.id;
      o.textContent = g.label;
      frag.appendChild(o);
    });
    const other = document.createElement('option');
    other.value = 'other';
    other.textContent = 'Another gig / not listed';
    frag.appendChild(other);
    els.gig.appendChild(frag);

    if (preselect && [...els.gig.options].some((o) => o.value === preselect)) els.gig.value = preselect;
    toggleOther();
  }

  function toggleOther() {
    const isOther = els.gig.value === 'other';
    els.otherWrap.hidden = !isOther;
    els.otherWrap.querySelectorAll('input').forEach((i) => { i.required = isOther; });
  }

  // ------------------------------------------------------------ config + Turnstile
  async function loadConfig() {
    try {
      const r = await fetch(`${API}/config`, { cache: 'no-store' });
      config = await r.json();
    } catch (e) {
      config = { ok: false, open: false };
    }
    if (!config.open) {
      els.closed.hidden = false;
      els.submit.disabled = true;
      return;
    }
    if (config.mode !== 'live') {
      els.banner.hidden = false;
      els.banner.textContent = config.mode === 'demo'
        ? 'PREVIEW / DEMO MODE: uploads run for real (chunking, progress, resume) but the video is thrown away and not stored anywhere. Bot check is in test mode.'
        : 'PREVIEW: uploads go to local test storage. Bot check is in test mode.';
    }
    if (els.consentVersion) els.consentVersion.value = config.consentVersion || '';
    renderTurnstile();
  }

  function renderTurnstile() {
    if (!config || !config.siteKey) return;
    if (!window.turnstile) { setTimeout(renderTurnstile, 250); return; }
    if (turnstileWidgetId !== null) return;
    turnstileWidgetId = window.turnstile.render('#turnstileBox', {
      sitekey: config.siteKey,
      theme: 'light',
      size: 'flexible',
      action: 'fan-video',
    });
  }

  // ------------------------------------------------------------ form helpers
  function setFieldError(name, msg) {
    const el = form.querySelector(`[data-error-for="${name}"]`);
    const input = form.querySelector(`[name="${name}"]`);
    if (el) { el.textContent = msg || ''; el.hidden = !msg; }
    if (input) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }
  function clearErrors() {
    form.querySelectorAll('[data-error-for]').forEach((el) => { el.textContent = ''; el.hidden = true; });
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.setAttribute('aria-invalid', 'false'));
    els.formError.hidden = true;
  }
  function showFormError(msg) {
    els.formError.textContent = msg;
    els.formError.hidden = false;
    els.formError.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function onFileChosen() {
    const f = els.file.files && els.file.files[0];
    setFieldError('video', '');
    if (!f) { els.fileLabel.textContent = 'No video chosen yet'; return; }
    els.fileLabel.textContent = `${f.name} · ${fmtBytes(f.size)}`;
    if (config && f.size > config.maxBytes) setFieldError('video', 'That video is over 4 GB. Please trim it a little or send it in two parts.');
    const rec = loadResume(fingerprint(f));
    if (rec) els.fileLabel.textContent += ' · we’ll resume your earlier upload';
  }

  // ------------------------------------------------------------ resume storage
  function fingerprint(f) { return `${f.name}|${f.size}|${f.lastModified}`; }
  function loadResume(fp) {
    try {
      const rec = JSON.parse(localStorage.getItem(RESUME_PREFIX + fp) || 'null');
      if (!rec) return null;
      if (Date.now() - rec.createdAt > 6 * 86400 * 1000) { localStorage.removeItem(RESUME_PREFIX + fp); return null; }
      return rec;
    } catch (e) { return null; }
  }
  function saveResume(fp, rec) {
    try { localStorage.setItem(RESUME_PREFIX + fp, JSON.stringify(rec)); } catch (e) { /* private mode: resume within session only */ }
  }
  function clearResume(fp) {
    try { localStorage.removeItem(RESUME_PREFIX + fp); } catch (e) {}
  }

  // ------------------------------------------------------------ wake lock
  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) { /* not supported or denied: fine */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (job && job.running && document.visibilityState === 'visible') keepAwake(true);
  });

  // ------------------------------------------------------------ network helpers
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function waitOnline() {
    if (navigator.onLine) return Promise.resolve();
    setStatus('Connection lost — waiting for signal. Keep this page open and we’ll carry on automatically.');
    return new Promise((r) => window.addEventListener('online', r, { once: true }));
  }

  async function postJSON(path, body) {
    const r = await fetch(`${API}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  }

  function putPart(n, blob, token, onProgress) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      job.xhrs.add(xhr);
      xhr.open('PUT', `${API}/part?n=${n}`);
      xhr.setRequestHeader('X-Upload-Token', token);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.timeout = 180000; // 3 min per 10 MB chunk (~0.45 Mbps minimum)
      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      const done = (result) => { job.xhrs.delete(xhr); resolve(result); };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch (e) {}
        done({ status: xhr.status, data });
      };
      xhr.onerror = () => done({ status: 0, data: {} });
      xhr.ontimeout = () => done({ status: 0, data: {}, timeout: true });
      xhr.onabort = () => done({ status: -1, data: {} });
      xhr.send(blob);
    });
  }

  // ------------------------------------------------------------ upload job
  function setStatus(msg) { els.status.textContent = msg; }

  function renderProgress() {
    if (!job) return;
    let sent = 0;
    job.doneBytes.forEach((b) => { sent += b; });
    job.inflight.forEach((b) => { sent += b; });
    sent = Math.min(sent, job.file.size);
    const pct = job.file.size ? Math.floor((sent / job.file.size) * 100) : 0;
    els.barFill.style.width = pct + '%';
    els.bar.setAttribute('aria-valuenow', String(pct));
    els.pct.textContent = pct + '%';

    const now = performance.now();
    job.samples.push([now, sent]);
    while (job.samples.length > 2 && now - job.samples[0][0] > 20000) job.samples.shift();
    const [t0, b0] = job.samples[0];
    const rate = now - t0 > 1500 ? ((sent - b0) / (now - t0)) * 1000 : 0;
    const eta = rate > 0 ? (job.file.size - sent) / rate : NaN;
    els.detail.textContent = `${fmtBytes(sent)} of ${fmtBytes(job.file.size)}${rate > 0 && fmtTime(eta) ? ' · ' + fmtTime(eta) : ''}`;
  }

  async function uploadChunk(n) {
    const { file, rec } = job;
    const start = (n - 1) * rec.partSize;
    const blob = file.slice(start, Math.min(start + rec.partSize, file.size));
    let tries = 0;
    for (;;) {
      if (!job.running) return false;
      await waitOnline();
      if (!job.running) return false;
      job.inflight.set(n, 0);
      const res = await putPart(n, blob, rec.token, (loaded) => { job.inflight.set(n, loaded); renderProgress(); });
      job.inflight.delete(n);
      if (res.status === 200 && res.data.etag) {
        rec.parts[n] = res.data.etag;
        job.doneBytes.set(n, blob.size);
        saveResume(job.fp, rec);
        renderProgress();
        if (job.running) setStatus('Uploading…');
        return true;
      }
      if (res.status === -1) return false; // paused / cancelled
      if (res.status === 403 && res.data.expired) throw Object.assign(new Error('expired'), { expired: true });
      if (res.status === 415 && res.data.notVideo) throw new Error(res.data.error);
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 && !res.data.retry) {
        throw new Error(res.data.error || 'Upload failed.');
      }
      // Network error, timeout, 408/429/5xx: back off and retry the same chunk.
      if (navigator.onLine) tries += 1;
      if (tries >= MAX_TRIES_ONLINE) throw new Error('The connection keeps dropping. Your progress is saved: pick the same video again later and it will carry on from here.');
      const wait = Math.min(30000, 1500 * 2 ** Math.min(tries, 5)) + Math.random() * 1000;
      setStatus(`Weak signal — retrying in ${Math.round(wait / 1000)} s. Nothing is lost.`);
      await sleep(wait);
    }
  }

  async function runJob() {
    job.running = true;
    els.pauseBtn.textContent = 'Pause';
    keepAwake(true);
    setStatus('Uploading…');
    const todo = [];
    for (let n = 1; n <= job.rec.partCount; n += 1) if (!job.rec.parts[n]) todo.push(n);

    const worker = async () => {
      while (job.running && todo.length) {
        const n = todo.shift();
        const ok = await uploadChunk(n);
        if (!ok) { todo.unshift(n); return; }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length || 1) }, worker));
      if (!job.running) return; // paused or cancelled
      setStatus('Finishing up…');
      const parts = Object.keys(job.rec.parts).map((k) => ({ partNumber: Number(k), etag: job.rec.parts[k] }));
      let fin;
      for (let i = 0; i < 5; i += 1) {
        await waitOnline();
        try { fin = await postJSON('complete', { token: job.rec.token, parts }); } catch (e) { fin = { status: 0, data: {} }; }
        if (fin.status === 200 || (fin.status >= 400 && fin.status < 500)) break;
        await sleep(2000 * (i + 1));
      }
      if (!fin || fin.status !== 200) throw new Error((fin && fin.data && fin.data.error) || 'We couldn’t finish saving the video. Please try again.');
      clearResume(job.fp);
      finishSuccess(fin.data.mode);
    } catch (e) {
      if (e.expired) clearResume(job.fp);
      job.running = false;
      keepAwake(false);
      els.progressPanel.hidden = true;
      form.hidden = false;
      els.submit.disabled = false;
      showFormError(e.message || 'Upload failed. Please try again.');
      resetTurnstile();
    }
  }

  function finishSuccess(mode) {
    job.running = false;
    keepAwake(false);
    els.barFill.style.width = '100%';
    els.pct.textContent = '100%';
    els.progressPanel.hidden = true;
    els.success.hidden = false;
    els.successMode.hidden = mode === 'live';
    els.successMode.textContent = mode === 'demo' ? '(Preview / demo mode: the video was received and checked, then discarded. Nothing was stored.)' : '(Preview: saved to test storage.)';
    els.success.scrollIntoView({ behavior: 'smooth', block: 'start' });
    job = null;
  }

  function resetTurnstile() {
    if (window.turnstile && turnstileWidgetId !== null) window.turnstile.reset(turnstileWidgetId);
  }

  // ------------------------------------------------------------ submit
  async function onSubmit(ev) {
    ev.preventDefault();
    clearErrors();
    if (!config || !config.open) return;
    const fd = new FormData(form);
    const f = els.file.files && els.file.files[0];

    // Client-side checks (the server checks everything again).
    let bad = false;
    if (String(fd.get('name') || '').trim().length < 2) { setFieldError('name', 'Please tell us your name.'); bad = true; }
    if (!els.gig.value) { setFieldError('gigId', 'Please choose which gig you filmed.'); bad = true; }
    if (!f) { setFieldError('video', 'Please choose your video.'); bad = true; }
    else if (f.size > config.maxBytes) { setFieldError('video', 'That video is over 4 GB. Please trim it a little or send it in two parts.'); bad = true; }
    if (!fd.get('consent')) { setFieldError('consent', 'Please tick the box so we can use and tag your video.'); bad = true; }
    if (bad) { showFormError('Please check the highlighted fields.'); return; }

    const fp = fingerprint(f);
    let rec = loadResume(fp);
    els.submit.disabled = true;

    if (!rec) {
      const turnstileToken = window.turnstile && turnstileWidgetId !== null ? window.turnstile.getResponse(turnstileWidgetId) : '';
      if (!turnstileToken) {
        els.submit.disabled = false;
        showFormError('Please complete the quick “I’m human” check just above the button.');
        return;
      }
      const gigOpt = els.gig.options[els.gig.selectedIndex];
      let res;
      try {
        res = await postJSON('start', {
          name: fd.get('name'),
          instagram: fd.get('instagram'),
          facebook: fd.get('facebook'),
          email: fd.get('email'),
          gigId: els.gig.value,
          gigLabel: gigOpt ? gigOpt.textContent : '',
          otherVenue: fd.get('otherVenue'),
          otherDate: fd.get('otherDate'),
          consent: fd.get('consent') === 'yes',
          consentVersion: fd.get('consentVersion'),
          website: fd.get('website'),
          turnstileToken,
          file: { name: f.name, size: f.size, type: f.type, lastModified: f.lastModified },
        });
      } catch (e) {
        res = { status: 0, data: { error: 'No connection. Please check your signal and try again.' } };
      }
      if (res.status !== 200) {
        els.submit.disabled = false;
        const fields = res.data.fields || {};
        Object.keys(fields).forEach((k) => setFieldError(k === 'file' ? 'video' : k, fields[k]));
        showFormError(res.data.error || 'Something went wrong. Please try again.');
        resetTurnstile();
        return;
      }
      rec = {
        token: res.data.token,
        key: res.data.key,
        partSize: res.data.partSize,
        partCount: res.data.partCount,
        parts: {},
        createdAt: Date.now(),
      };
      saveResume(fp, rec);
    }

    job = {
      file: f, fp, rec, running: false,
      xhrs: new Set(), inflight: new Map(), doneBytes: new Map(), samples: [],
    };
    Object.keys(rec.parts).forEach((k) => {
      const n = Number(k);
      job.doneBytes.set(n, n < rec.partCount ? rec.partSize : f.size - rec.partSize * (rec.partCount - 1));
    });

    form.hidden = true;
    els.progressPanel.hidden = false;
    els.progressPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    renderProgress();
    runJob();
  }

  function onPause() {
    if (!job) return;
    if (job.running) {
      job.running = false;
      job.xhrs.forEach((x) => x.abort());
      keepAwake(false);
      els.pauseBtn.textContent = 'Resume';
      setStatus('Paused. Your progress is saved.');
    } else {
      job.samples = [];
      runJob();
    }
  }

  async function onCancel() {
    if (!job) return;
    if (!confirm('Cancel this upload? You’d need to start again from the beginning.')) return;
    job.running = false;
    job.xhrs.forEach((x) => x.abort());
    keepAwake(false);
    const { rec, fp } = job;
    clearResume(fp);
    postJSON('abort', { token: rec.token }).catch(() => {});
    job = null;
    els.progressPanel.hidden = true;
    form.hidden = false;
    els.submit.disabled = false;
    resetTurnstile();
  }

  function onAnother() {
    // Keep name / handles / gig, clear the video and the tick box.
    els.file.value = '';
    onFileChosen();
    form.querySelector('[name="consent"]').checked = false;
    els.success.hidden = true;
    form.hidden = false;
    els.submit.disabled = false;
    resetTurnstile();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  window.addEventListener('beforeunload', (e) => {
    if (job && job.running) { e.preventDefault(); e.returnValue = ''; }
  });

  els.gig.addEventListener('change', toggleOther);
  els.file.addEventListener('change', onFileChosen);
  // Clear a field's error as soon as the fan fixes it; tidy an Instagram "@" typed by the fan.
  form.addEventListener('input', (e) => { if (e.target.name) setFieldError(e.target.name, ''); });
  form.addEventListener('change', (e) => { if (e.target.name && e.target.name !== 'video') setFieldError(e.target.name, ''); });
  const ig = form.querySelector('#instagram');
  ig.addEventListener('input', () => { if (ig.value.startsWith('@')) ig.value = ig.value.replace(/^@+/, ''); });
  els.pauseBtn.addEventListener('click', onPause);
  els.cancelBtn.addEventListener('click', onCancel);
  els.another.addEventListener('click', onAnother);
  form.addEventListener('submit', onSubmit);

  loadGigs();
  loadConfig();
})();
