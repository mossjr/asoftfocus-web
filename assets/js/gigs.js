/* A Soft Focus — automatic "Next Gig" hero, Upcoming Gigs list & MusicEvent JSON-LD.
 *
 * On every page load this reads gigs-data.json + assets/images/venues/manifest.json
 * (built by tools/sync_venue_photos.py) and compares each gig against the
 * current time (Australia/Brisbane = UTC+10 all year, no daylight saving):
 *   - features the first public gig whose end time hasn't passed in #nextGig
 *   - photo = manifest[gig.venue] (stable pick per gig id), else manifest._placeholder
 *   - lists all not-yet-ended gigs in #upcomingGigsList (hides the block if none)
 *   - moves ended gigs to the top of the Recent Shows list (#recentGigsList)
 *   - rewrites the MusicEvent JSON-LD (#gigsJsonLd) to upcoming gigs only
 *   - builds an "Add to calendar" .ics file client-side
 * The server-rendered HTML (tools/prerender_gigs.py) is the no-JS/SEO fallback;
 * keep the markup here in sync with that script.
 */
(function () {
  'use strict';

  var SITE_URL = 'https://asoftfocus.com/';
  var DEFAULT_IMAGE = 'assets/images/hero-duo-velvet.webp';
  var BNE_OFFSET_MS = 10 * 60 * 60 * 1000;
  var DAY_MS = 86400000;
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  var ANCHOR_SVG =
    '<svg class="venue-fallback-icon" viewBox="0 0 64 64" aria-hidden="true">' +
    '<circle cx="32" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="3"/>' +
    '<path d="M32 17v34M20 26h24M10 38c2 10 11 15 22 15s20-5 22-15M10 38l-4 4M10 38l5 3M54 38l4 4M54 38l-5 3" ' +
    'fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Brisbane wall-clock view of an instant (read with getUTC* methods).
  function bne(ms) { return new Date(ms + BNE_OFFSET_MS); }
  function bneDayNumber(ms) { return Math.floor((ms + BNE_OFFSET_MS) / DAY_MS); }

  function timeStr(ms) {
    var d = bne(ms), h = d.getUTCHours(), m = d.getUTCMinutes();
    return ((h % 12) || 12) + ':' + (m < 10 ? '0' : '') + m + (h < 12 ? 'am' : 'pm');
  }
  function dateLong(ms) {
    var d = bne(ms);
    return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }
  function dateShort(ms) {
    var d = bne(ms);
    return DAYS[d.getUTCDay()].slice(0, 3) + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCFullYear();
  }
  function fullAddress(g) {
    return (g.address + ', ' + g.town + ' ' + (g.region || 'QLD') + ' ' + (g.postcode || '')).trim();
  }
  function venueName(g) { return g.venueName || g.venue; }

  // FNV-1a 32-bit — stable per gig id, so a venue with several photos always
  // shows the same one for a given gig (no flicker between reloads).
  // Keep identical to fnv1a() in tools/prerender_gigs.py.
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // Photo for a gig: manifest[venue] -> else the "_placeholder" band photo -> else null (branded card).
  function pickImage(g, manifest) {
    var own = manifest && manifest[g.venue] && manifest[g.venue].images;
    var list = own && own.length ? own : (manifest && manifest._placeholder && manifest._placeholder.images) || [];
    if (!list.length) return null;
    var img = list[fnv1a(String(g.id)) % list.length];
    return { src: img.src, credit: img.credit, placeholder: !(own && own.length) };
  }

  function countdown(g, now) {
    if (now >= g._start && now < g._end) return 'On now';
    var days = bneDayNumber(g._start) - bneDayNumber(now);
    if (days <= 0) return bne(g._start).getUTCHours() >= 17 ? 'Tonight' : 'Today';
    if (days === 1) return 'Tomorrow';
    return 'in ' + days + ' days';
  }

  // Southern-hemisphere seasons: Summer Dec–Feb, Autumn Mar–May, Winter Jun–Aug, Spring Sep–Nov.
  function nextSeason(now) {
    var d = bne(now), m = d.getUTCMonth(), y = d.getUTCFullYear();
    if (m >= 8 && m <= 10) return 'Summer ' + y + '–' + String(y + 1).slice(2);
    if (m === 11) return 'Autumn ' + (y + 1);
    if (m <= 1) return 'Autumn ' + y;
    if (m <= 4) return 'Winter ' + y;
    return 'Spring ' + y;
  }

  // ---------- .ics ----------
  function icsDate(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
  function icsEsc(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
  function fold(line) {
    var out = '';
    while (line.length > 73) { out += line.slice(0, 73) + '\r\n '; line = line.slice(73); }
    return out + line;
  }
  function buildIcs(g) {
    return [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//A Soft Focus//Gigs//EN',
      'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
      'UID:' + g.id + '@asoftfocus.com', 'DTSTAMP:' + icsDate(Date.now()),
      'DTSTART:' + icsDate(g._start), 'DTEND:' + icsDate(g._end),
      'SUMMARY:' + icsEsc(g.title),
      'LOCATION:' + icsEsc(venueName(g) + ', ' + fullAddress(g)),
      'DESCRIPTION:' + icsEsc('A Soft Focus live at ' + venueName(g) + '. Directions: ' + g.mapsUrl),
      'URL:' + SITE_URL, 'END:VEVENT', 'END:VCALENDAR'
    ].map(fold).join('\r\n') + '\r\n';
  }
  function wireIcs(link, g) {
    if (!link || !window.Blob || !window.URL || !URL.createObjectURL) return; // keep static .ics fallback
    try {
      link.href = URL.createObjectURL(new Blob([buildIcs(g)], { type: 'text/calendar;charset=utf-8' }));
      link.setAttribute('download', g.id + '.ics');
    } catch (err) { /* static fallback href stays */ }
  }

  // ---------- markup (keep in sync with tools/prerender_gigs.py) ----------
  function imgAlt(g) {
    return g._img && g._img.placeholder
      ? 'A Soft Focus performing live — piano & vocals'
      : venueName(g) + ', ' + g.town;
  }

  function mediaHtml(g) {
    if (g._img) {
      return '<img src="' + esc(g._img.src) + '" alt="' + esc(imgAlt(g)) + '" loading="eager" />' +
        (g._img.credit ? '<span class="next-gig-credit">' + esc(g._img.credit) + '</span>' : '');
    }
    return '<div class="venue-fallback" role="img" aria-label="' + esc(venueName(g)) + '">' + ANCHOR_SVG +
      '<span class="venue-fallback-name">' + esc(venueName(g)) + '</span>' +
      '<span class="venue-fallback-town">' + esc(g.town) + '</span></div>';
  }

  function nextHtml(g) {
    return '<div class="next-gig-media">' + mediaHtml(g) + '</div>' +
      '<div class="next-gig-body">' +
      '<div class="next-gig-eyebrow"><span class="live-dot" aria-hidden="true"></span>Next Gig' +
      '<span class="next-gig-countdown" data-countdown hidden></span></div>' +
      '<h2 class="next-gig-venue">' + esc(venueName(g)) + '</h2>' +
      '<ul class="next-gig-meta">' +
      '<li><span>Date</span><strong>' + esc(dateLong(g._start)) + '</strong></li>' +
      '<li><span>Time</span><strong>' + esc(timeStr(g._start)) + ' – ' + esc(timeStr(g._end)) + '</strong></li>' +
      '<li><span>Where</span><strong>' + esc(fullAddress(g)) + '</strong></li>' +
      '</ul>' +
      '<div class="next-gig-actions">' +
      '<a class="btn-gold" href="' + esc(g.mapsUrl) + '" target="_blank" rel="noopener">Get directions ↗</a>' +
      '<a class="btn-white-key" href="assets/ics/' + esc(g.id) + '.ics" download="' + esc(g.id) + '.ics" data-ics>Add to calendar</a>' +
      '</div>' +
      '<a class="next-gig-more" href="#upcoming">See all upcoming gigs ↓</a>' +
      '</div>';
  }

  function emptyHtml(now) {
    return '<div class="next-gig-body next-gig-empty">' +
      '<div class="next-gig-eyebrow"><span class="live-dot" aria-hidden="true"></span>Next Gig</div>' +
      '<h2 class="next-gig-venue">Booking now for ' + esc(nextSeason(now)) + '</h2>' +
      '<p>No public shows are announced right now. Venues, private events and weddings — get in touch to lock in a date.</p>' +
      '<div class="next-gig-actions"><a class="btn-gold" href="#book">Enquire about a date ✦</a></div>' +
      '</div>';
  }

  function thumbHtml(g) {
    if (!g._img) return '';
    return '<span class="gig-thumb"><img src="' + esc(g._img.src) + '" alt="" loading="lazy" /></span>';
  }
  function creditLine(g) {
    return g._img && g._img.credit ? '<small class="gig-photo-credit">' + esc(g._img.credit) + '</small>' : '';
  }

  function rowHtml(g, past) {
    return '<div class="gig-row" data-gig-id="' + esc(g.id) + '">' +
      '<div class="gig-date">' + esc(dateShort(g._start)) + '</div>' +
      '<div class="gig-venue">' + thumbHtml(g) + '<span class="gig-venue-text"><strong>' + esc(venueName(g)) + '</strong><span>' + esc(g.address) + ', ' + esc(g.town) + '</span>' + creditLine(g) + '</span></div>' +
      '<div class="gig-type">' + esc(timeStr(g._start)) + ' – ' + esc(timeStr(g._end)) + ' • ' + esc(g.format) + '</div>' +
      (past
        ? '<span class="gig-badge">Recent Show</span>'
        : '<a class="gig-badge" href="' + esc(g.mapsUrl) + '" target="_blank" rel="noopener">Directions ↗</a>') +
      '</div>';
  }

  function eventLd(g) {
    return {
      '@context': 'https://schema.org',
      '@type': 'MusicEvent',
      name: g.title,
      startDate: g.start,
      endDate: g.end,
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      description: 'A Soft Focus (piano & vocal duo) live at ' + venueName(g) + ', ' + g.town + '.',
      image: [SITE_URL + (g._img ? g._img.src : DEFAULT_IMAGE)],
      url: SITE_URL + '#upcoming',
      location: {
        '@type': 'Place',
        name: venueName(g),
        address: {
          '@type': 'PostalAddress',
          streetAddress: g.address,
          addressLocality: g.town,
          addressRegion: g.region || 'QLD',
          postalCode: g.postcode || '',
          addressCountry: 'AU'
        }
      },
      performer: { '@type': 'MusicGroup', name: 'A Soft Focus', url: SITE_URL }
    };
  }

  // ---------- render ----------
  function render(data, manifest) {
    var now = Date.now();
    var gigs = (data.upcomingGigs || []).filter(function (g) {
      if (!g || g.public !== true) return false;
      g._start = Date.parse(g.start);
      g._end = Date.parse(g.end);
      g._img = pickImage(g, manifest);
      return !isNaN(g._start) && !isNaN(g._end);
    }).sort(function (a, b) { return a._start - b._start; });

    var upcoming = gigs.filter(function (g) { return g._end > now; });
    var past = gigs.filter(function (g) { return g._end <= now; }).reverse(); // most recent first

    // Next Gig hero
    var hero = document.getElementById('nextGig');
    if (hero) {
      if (upcoming.length) {
        var g = upcoming[0];
        hero.classList.remove('is-empty');
        hero.setAttribute('data-gig-id', g.id);
        hero.innerHTML = nextHtml(g);
        var cd = hero.querySelector('[data-countdown]');
        if (cd) { cd.textContent = countdown(g, now); cd.hidden = false; }
        wireIcs(hero.querySelector('[data-ics]'), g);
      } else {
        hero.classList.add('is-empty');
        hero.removeAttribute('data-gig-id');
        hero.innerHTML = emptyHtml(now);
      }
    }

    // Upcoming list
    var list = document.getElementById('upcomingGigsList');
    var block = document.getElementById('upcoming');
    if (list) list.innerHTML = upcoming.map(function (x) { return rowHtml(x, false); }).join('');
    if (block) block.hidden = upcoming.length === 0;

    // Ended gigs go to the top of Recent Shows
    var recent = document.getElementById('recentGigsList');
    if (recent && past.length) {
      var html = past.filter(function (x) {
        return !recent.querySelector('[data-gig-id="' + x.id + '"]');
      }).map(function (x) { return rowHtml(x, true); }).join('');
      recent.insertAdjacentHTML('afterbegin', html);
    }

    // MusicEvent JSON-LD for upcoming gigs only
    var ld = document.getElementById('gigsJsonLd');
    if (!ld) {
      ld = document.createElement('script');
      ld.type = 'application/ld+json';
      ld.id = 'gigsJsonLd';
      document.head.appendChild(ld);
    }
    ld.textContent = JSON.stringify(upcoming.map(eventLd));
  }

  function getJson(url) {
    return fetch(url, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  function start() {
    // The photo manifest is optional: if it fails we still render (branded card fallback).
    var manifestP = getJson('assets/images/venues/manifest.json').catch(function () { return {}; });
    Promise.all([getJson('gigs-data.json'), manifestP])
      .then(function (res) {
        var data = res[0], manifest = res[1];
        render(data, manifest);
        // Keep an open tab current: refresh the countdown every minute and
        // re-render when the featured gig ends.
        setInterval(function () {
          var now = Date.now();
          var hero = document.getElementById('nextGig');
          var cd = hero && hero.querySelector('[data-countdown]');
          var current = (data.upcomingGigs || []).filter(function (g) { return g._end > now && g.public === true; })
            .sort(function (a, b) { return a._start - b._start; })[0];
          if (!current) { if (!hero.classList.contains('is-empty')) render(data, manifest); return; }
          if (hero.getAttribute('data-gig-id') !== current.id) { render(data, manifest); return; }
          if (cd) cd.textContent = countdown(current, now);
        }, 60000);
      })
      .catch(function () { /* keep server-rendered fallback */ });
  }

  if (window.fetch && window.Promise) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})();
