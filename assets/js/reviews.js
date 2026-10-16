/*
 * A Soft Focus — hero Google-review slider.
 *
 * Reads "reviews" from gigs-data.json (newest first) and turns the server-rendered first review
 * (tools/prerender_gigs.py — keep the slide markup in sync) into an accessible slider:
 *   - fades every 6.5 s; pauses on hover, on keyboard focus, when the tab is hidden, or via the pause button
 *   - prefers-reduced-motion: no auto-advance (manual controls only)
 *   - prev / dots / next are real buttons (keyboard + screen readers); ← → work while focus is inside
 *   - swipe left/right on touch screens
 *   - aria-live is "off" while auto-rotating (no announcement every 6.5 s), "polite" after a manual change
 *   - a single review renders statically with no controls; no JS = the first review, still linked
 * Deliberately NO Review / AggregateRating JSON-LD (self-serving review markup is against Google's guidelines).
 */
(function () {
  'use strict';
  var root = document.getElementById('heroReviews');
  if (!root || !window.fetch) return;

  var LISTING = 'https://www.google.com/maps?cid=11276664409404347226';
  var LEAVE = 'https://g.page/r/CVoT1rWIwn6cEBM/review';
  var INTERVAL = 6500;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function stars(r) {
    var n = Math.max(0, Math.min(5, parseInt(r.rating, 10) || 5));
    return new Array(n + 1).join('★') + new Array(6 - n).join('☆');
  }
  function attribution(r) {
    var tail = [r.event_type, (r.source || 'Google') + ' review'].filter(Boolean).join(' · ');
    return r.author_display ? '— ' + r.author_display + ', ' + tail : '— ' + tail;
  }
  function slide(r, i, n) {
    var rating = parseInt(r.rating, 10) || 5;
    return '<figure class="hr-slide' + (i === 0 ? ' is-active' : '') + '" role="group" aria-roledescription="slide" aria-label="Review ' + (i + 1) + ' of ' + n + '"' + (i === 0 ? '' : ' aria-hidden="true"') + '>' +
      '<div class="hr-stars" role="img" aria-label="' + rating + ' out of 5 stars on ' + esc(r.source || 'Google') + '">' + stars(r) + '</div>' +
      '<blockquote><a href="' + LISTING + '" target="_blank" rel="noopener">“' + esc(r.text) + '”</a></blockquote>' +
      '<figcaption>' + esc(attribution(r)) + '</figcaption></figure>';
  }

  fetch('gigs-data.json', { cache: 'no-cache' })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (d) { if (d) build(d.reviews || []); })
    .catch(function () { /* keep the server-rendered review */ });

  function build(list) {
    var revs = list.filter(function (r) { return r && r.text; })
      .map(function (r, i) { return { r: r, i: i }; })
      .sort(function (a, b) { return (b.r.date || '').localeCompare(a.r.date || '') || a.i - b.i; })
      .map(function (x) { return x.r; });
    if (!revs.length) { root.hidden = true; return; }
    var n = revs.length;

    var controls = '';
    if (n > 1) {
      controls = '<div class="hr-controls" role="group" aria-label="Choose a review">' +
        '<button type="button" class="hr-btn" data-go="prev" aria-label="Previous review">‹</button>' +
        revs.map(function (r, i) {
          return '<button type="button" class="hr-dot" data-go="' + i + '" aria-label="Review ' + (i + 1) + ' of ' + n + ', ' + esc(r.author_display || '') + '"' + (i === 0 ? ' aria-current="true"' : '') + '></button>';
        }).join('') +
        '<button type="button" class="hr-btn" data-go="next" aria-label="Next review">›</button>' +
        (reduced ? '' : '<button type="button" class="hr-btn" data-go="toggle" aria-label="Pause reviews">❚❚</button>') +
        '</div>';
    }
    root.innerHTML = '<div class="hr-track" aria-live="' + (n > 1 && !reduced ? 'off' : 'polite') + '">' +
      revs.map(function (r, i) { return slide(r, i, n); }).join('') + '</div>' +
      '<div class="hr-foot">' + controls + '<a class="hr-leave" href="' + LEAVE + '" target="_blank" rel="noopener">Leave us a review ↗</a></div>';
    if (n < 2) return; // a single review is static: no controls, no timer

    var track = root.querySelector('.hr-track');
    var slides = root.querySelectorAll('.hr-slide');
    var dots = root.querySelectorAll('.hr-dot');
    var toggle = root.querySelector('[data-go="toggle"]');
    var idx = 0, timer = null, hover = false, focus = false, userPaused = reduced;

    function show(i, manual) {
      idx = (i + n) % n;
      for (var k = 0; k < n; k++) {
        var on = k === idx;
        slides[k].classList.toggle('is-active', on);
        if (on) slides[k].removeAttribute('aria-hidden'); else slides[k].setAttribute('aria-hidden', 'true');
        if (on) dots[k].setAttribute('aria-current', 'true'); else dots[k].removeAttribute('aria-current');
      }
      if (manual) track.setAttribute('aria-live', 'polite'); // announce only what the visitor asked for
    }
    function running() { return !userPaused && !hover && !focus && !document.hidden; }
    function schedule() {
      clearInterval(timer); timer = null;
      if (running()) {
        track.setAttribute('aria-live', 'off');
        timer = setInterval(function () { show(idx + 1, false); }, INTERVAL);
      }
    }

    root.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-go]') : null;
      if (!b) return;
      var go = b.getAttribute('data-go');
      if (go === 'toggle') {
        userPaused = !userPaused;
        b.setAttribute('aria-label', userPaused ? 'Play reviews' : 'Pause reviews');
        b.textContent = userPaused ? '▶' : '❚❚';
        if (userPaused) track.setAttribute('aria-live', 'polite');
      } else {
        show(go === 'prev' ? idx - 1 : go === 'next' ? idx + 1 : parseInt(go, 10), true);
      }
      schedule();
    });
    root.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      show(idx + (e.key === 'ArrowLeft' ? -1 : 1), true);
      e.preventDefault();
    });
    root.addEventListener('mouseenter', function () { hover = true; schedule(); });
    root.addEventListener('mouseleave', function () { hover = false; schedule(); });
    root.addEventListener('focusin', function () { focus = true; schedule(); });
    root.addEventListener('focusout', function (e) {
      if (!root.contains(e.relatedTarget)) { focus = false; schedule(); }
    });
    document.addEventListener('visibilitychange', schedule);

    // Swipe (touch only; vertical scrolling is left alone).
    var sx = null, sy = null;
    track.addEventListener('touchstart', function (e) { var t = e.touches[0]; sx = t.clientX; sy = t.clientY; }, { passive: true });
    track.addEventListener('touchend', function (e) {
      if (sx === null) return;
      var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      sx = sy = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) { show(idx + (dx < 0 ? 1 : -1), true); schedule(); }
    }, { passive: true });

    schedule();
  }
})();
