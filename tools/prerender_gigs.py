#!/usr/bin/env python3
"""Pre-render the "Next Gig" hero, Upcoming Gigs rows, MusicEvent JSON-LD and
static .ics files from gigs-data.json into index.html.

This is only the no-JavaScript / SEO fallback. In the browser,
assets/js/gigs.js re-reads gigs-data.json on every page load and re-renders
everything against the current time in Australia/Brisbane, so the live site
stays correct as gigs pass without needing a redeploy. Re-run this script
whenever you edit upcomingGigs so the static fallback stays fresh:

    python3 tools/prerender_gigs.py            # uses the current time
    python3 tools/prerender_gigs.py --now 2026-10-25T00:00:00+10:00

Markup here must stay in sync with assets/js/gigs.js.
"""
import argparse
import html
import json
import os
import re
from datetime import datetime, timedelta, timezone

SITE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE_URL = "https://asoftfocus.com/"
DEFAULT_IMAGE = "assets/images/hero-duo-velvet.webp"
BNE = timezone(timedelta(hours=10))  # Brisbane: UTC+10 all year, no daylight saving

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]

ANCHOR_SVG = (
    '<svg class="venue-fallback-icon" viewBox="0 0 64 64" aria-hidden="true">'
    '<circle cx="32" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="3"/>'
    '<path d="M32 17v34M20 26h24M10 38c2 10 11 15 22 15s20-5 22-15M10 38l-4 4M10 38l5 3M54 38l4 4M54 38l-5 3" '
    'fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
    '</svg>'
)


def e(s):
    return html.escape("" if s is None else str(s), quote=True)


def parse(s):
    return datetime.fromisoformat(s).astimezone(BNE)


def time_str(d):
    h = d.hour % 12 or 12
    return f"{h}:{d.minute:02d}{'am' if d.hour < 12 else 'pm'}"


def date_long(d):
    return f"{DAYS[d.weekday()]} {d.day} {MONTHS[d.month - 1]} {d.year}"


def date_short(d):
    return f"{DAYS[d.weekday()][:3]} {d.day} {MONTHS[d.month - 1][:3]} {d.year}"


def full_address(g):
    return f"{g['address']}, {g['town']} {g.get('region', 'QLD')} {g.get('postcode', '')}".strip()


def venue_name(g):
    return g.get("venueName") or g["venue"]


def fnv1a(s):
    """FNV-1a 32-bit over UTF-16 code units — identical to fnv1a() in assets/js/gigs.js."""
    h = 0x811C9DC5
    b = s.encode("utf-16-le")
    for i in range(0, len(b), 2):
        h ^= b[i] | (b[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def pick_image(g, manifest):
    own = (manifest.get(g["venue"]) or {}).get("images") or []
    lst = own or (manifest.get("_placeholder") or {}).get("images") or []
    if not lst:
        return None
    img = lst[fnv1a(str(g["id"])) % len(lst)]
    return {"src": img["src"], "credit": img.get("credit"), "placeholder": not own}


def img_alt(g):
    if g.get("_img") and g["_img"]["placeholder"]:
        return "A Soft Focus performing live — piano & vocals"
    return f"{venue_name(g)}, {g['town']}"


def media_html(g):
    img = g.get("_img")
    if img:
        credit = f'<span class="next-gig-credit">{e(img["credit"])}</span>' if img.get("credit") else ""
        return f'<img src="{e(img["src"])}" alt="{e(img_alt(g))}" loading="eager" />{credit}'
    return (f'<div class="venue-fallback" role="img" aria-label="{e(venue_name(g))}">{ANCHOR_SVG}'
            f'<span class="venue-fallback-name">{e(venue_name(g))}</span>'
            f'<span class="venue-fallback-town">{e(g["town"])}</span></div>')


def next_html(g):
    s, en = parse(g["start"]), parse(g["end"])
    return (
        f'<div class="next-gig-media">{media_html(g)}</div>'
        '<div class="next-gig-body">'
        '<div class="next-gig-eyebrow"><span class="live-dot" aria-hidden="true"></span>Next Gig'
        '<span class="next-gig-countdown" data-countdown hidden></span></div>'
        f'<h2 class="next-gig-venue">{e(venue_name(g))}</h2>'
        '<ul class="next-gig-meta">'
        f'<li><span>Date</span><strong>{e(date_long(s))}</strong></li>'
        f'<li><span>Time</span><strong>{e(time_str(s))} – {e(time_str(en))}</strong></li>'
        f'<li><span>Where</span><strong>{e(full_address(g))}</strong></li>'
        '</ul>'
        '<div class="next-gig-actions">'
        f'<a class="btn-gold" href="{e(g["mapsUrl"])}" target="_blank" rel="noopener">Get directions ↗</a>'
        f'<a class="btn-white-key" href="assets/ics/{e(g["id"])}.ics" download="{e(g["id"])}.ics" data-ics>Add to calendar</a>'
        '</div>'
        '<a class="next-gig-more" href="#upcoming">See all upcoming gigs ↓</a>'
        '</div>'
    )


def next_season(now):
    d = now.astimezone(BNE)
    m, y = d.month, d.year
    if 9 <= m <= 11:
        return f"Summer {y}–{str(y + 1)[2:]}"
    if m == 12:
        return f"Autumn {y + 1}"
    if m <= 2:
        return f"Autumn {y}"
    if m <= 5:
        return f"Winter {y}"
    return f"Spring {y}"


def empty_html(now):
    return (
        '<div class="next-gig-body next-gig-empty">'
        '<div class="next-gig-eyebrow"><span class="live-dot" aria-hidden="true"></span>Next Gig</div>'
        f'<h2 class="next-gig-venue">Booking now for {e(next_season(now))}</h2>'
        '<p>No public shows are announced right now. Venues, private events and weddings — get in touch to lock in a date.</p>'
        '<div class="next-gig-actions"><a class="btn-gold" href="#book">Enquire about a date ✦</a></div>'
        '</div>'
    )


def thumb_html(g):
    img = g.get("_img")
    if not img:
        return ""
    return f'<span class="gig-thumb"><img src="{e(img["src"])}" alt="" loading="lazy" /></span>'


def credit_line(g):
    img = g.get("_img")
    return f'<small class="gig-photo-credit">{e(img["credit"])}</small>' if img and img.get("credit") else ""


def row_html(g):
    s, en = parse(g["start"]), parse(g["end"])
    return (
        f'<div class="gig-row" data-gig-id="{e(g["id"])}">'
        f'<div class="gig-date">{e(date_short(s))}</div>'
        f'<div class="gig-venue">{thumb_html(g)}<span class="gig-venue-text"><strong>{e(venue_name(g))}</strong>'
        f'<span>{e(g["address"])}, {e(g["town"])}</span>{credit_line(g)}</span></div>'
        f'<div class="gig-type">{e(time_str(s))} – {e(time_str(en))} • {e(g["format"])}</div>'
        f'<a class="gig-badge" href="{e(g["mapsUrl"])}" target="_blank" rel="noopener">Directions ↗</a>'
        '</div>'
    )


def event_ld(g):
    return {
        "@context": "https://schema.org",
        "@type": "MusicEvent",
        "name": g["title"],
        "startDate": g["start"],
        "endDate": g["end"],
        "eventStatus": "https://schema.org/EventScheduled",
        "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
        "description": f"A Soft Focus (piano & vocal duo) live at {venue_name(g)}, {g['town']}.",
        "image": [SITE_URL + (g["_img"]["src"] if g.get("_img") else DEFAULT_IMAGE)],
        "url": SITE_URL + "#upcoming",
        "location": {
            "@type": "Place",
            "name": venue_name(g),
            "address": {
                "@type": "PostalAddress",
                "streetAddress": g["address"],
                "addressLocality": g["town"],
                "addressRegion": g.get("region", "QLD"),
                "postalCode": g.get("postcode", ""),
                "addressCountry": "AU",
            },
        },
        "performer": {"@type": "MusicGroup", "name": "A Soft Focus", "url": SITE_URL},
    }


def ics_text(g, stamp):
    def ics_date(s):
        return datetime.fromisoformat(s).astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    def esc(s):
        return str(s).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")

    def fold(line):
        out = ""
        while len(line) > 73:
            out += line[:73] + "\r\n "
            line = line[73:]
        return out + line

    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//A Soft Focus//Gigs//EN",
        "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VEVENT",
        f"UID:{g['id']}@asoftfocus.com", f"DTSTAMP:{stamp}",
        f"DTSTART:{ics_date(g['start'])}", f"DTEND:{ics_date(g['end'])}",
        f"SUMMARY:{esc(g['title'])}",
        f"LOCATION:{esc(venue_name(g) + ', ' + full_address(g))}",
        f"DESCRIPTION:{esc('A Soft Focus live at ' + venue_name(g) + '. Directions: ' + g['mapsUrl'])}",
        f"URL:{SITE_URL}", "END:VEVENT", "END:VCALENDAR",
    ]
    return "\r\n".join(fold(l) for l in lines) + "\r\n"


def replace_block(doc, name, content):
    pattern = re.compile(r"(<!-- GIGS:%s:START -->)(.*?)(<!-- GIGS:%s:END -->)" % (name, name), re.S)
    if not pattern.search(doc):
        raise SystemExit(f"marker GIGS:{name} not found in index.html")
    return pattern.sub(lambda m: m.group(1) + content + m.group(3), doc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--now", help="ISO 8601 time to render as (default: now)")
    args = ap.parse_args()
    now = datetime.fromisoformat(args.now) if args.now else datetime.now(timezone.utc)

    data = json.load(open(os.path.join(SITE_DIR, "gigs-data.json"), encoding="utf-8"))
    try:
        manifest = json.load(open(os.path.join(SITE_DIR, "assets", "images", "venues", "manifest.json"), encoding="utf-8"))
    except FileNotFoundError:
        manifest = {}
    gigs = sorted((g for g in data.get("upcomingGigs", []) if g.get("public")), key=lambda g: g["start"])
    for g in gigs:
        g["_img"] = pick_image(g, manifest)
    upcoming = [g for g in gigs if datetime.fromisoformat(g["end"]) > now]

    ics_dir = os.path.join(SITE_DIR, "assets", "ics")
    os.makedirs(ics_dir, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    stamp_re = re.compile(r"^DTSTAMP:.*$", re.M)
    for g in gigs:
        ics_path = os.path.join(ics_dir, g["id"] + ".ics")
        new = ics_text(g, stamp)
        try:
            old = open(ics_path, encoding="utf-8", newline="").read()
        except FileNotFoundError:
            old = None
        # Only rewrite when the event itself changed (ignore DTSTAMP) so repeated runs are no-ops.
        if old is not None and stamp_re.sub("", old) == stamp_re.sub("", new):
            continue
        with open(ics_path, "w", encoding="utf-8", newline="") as f:
            f.write(new)

    path = os.path.join(SITE_DIR, "index.html")
    doc = open(path, encoding="utf-8").read()
    doc = replace_block(doc, "NEXT", next_html(upcoming[0]) if upcoming else empty_html(now))
    doc = replace_block(doc, "UPCOMING", "".join(row_html(g) for g in upcoming))
    ld = json.dumps([event_ld(g) for g in upcoming], ensure_ascii=False, indent=2).replace("</", "<\\/")
    doc = replace_block(doc, "JSONLD", f'<script type="application/ld+json" id="gigsJsonLd">{ld}</script>')
    open(path, "w", encoding="utf-8").write(doc)
    print(f"Rendered {len(upcoming)} upcoming gig(s); next: {upcoming[0]['id'] if upcoming else 'none'}")


if __name__ == "__main__":
    main()
