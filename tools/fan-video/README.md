# Fan video submissions: how it works and how to switch it on

Status (21 Oct 2026): built and tested on branch `feature/fan-video-submissions`.
**Not live.** Nothing is linked from the site, the page is `noindex`, and the API refuses
uploads on asoftfocus.com until every switch below is set.

## How it works

```
Phone (submit-video.html)
  │  1. form + Turnstile check  ──►  POST /api/fan-video/start     (Pages Function)
  │                                   validates, opens R2 multipart upload, writes <key>.json
  │  2. video in 10 MB chunks   ──►  PUT  /api/fan-video/part?n=N  (3 at a time, retried, resumable)
  │  3. finish                  ──►  POST /api/fan-video/complete  stitches chunks, checks size,
  │                                   marks <key>.json "received", sends notification webhook
  ▼
R2 bucket asoftfocus-fan-videos/inbox/<gig>/<file>        (private, never public)
  │  tools/fan-video/fan_videos_to_drive.py (rclone, on Kyle's Mac on a schedule)
  ▼
Google Drive "A Soft Focus — Fan Videos"/<gig>/<file> + submissions-log.csv
```

* Chunks go through our own Function (same domain), so there are no R2 API keys in the
  browser and no CORS setup. Each chunk is 10 MiB, well under Cloudflare's 100 MB request limit.
* Max video 4 GB. Chunk 1 is checked for a real video header (MP4/MOV/WebM); anything else is rejected.
* Resume: chunk progress is saved in the phone's browser. If the page closes, the fan picks the
  same video again and it carries on. Unfinished uploads expire after 6 days (R2 discards them at 7).
* Spam: Cloudflare Turnstile (free), honeypot field, signed per-upload tokens, exact chunk-size
  checks, video-only, size cap, private bucket.

### File naming

```
inbox/2026-10-24_8-bit-bar/2026-10-25_jane-smith_ig-jane-smith_4b6d64.mov
inbox/2026-10-24_8-bit-bar/2026-10-25_jane-smith_ig-jane-smith_4b6d64.mov.json   ← form answers + consent
       └ gig date_venue      └ upload date_name_handle_id
```
"Another gig" submissions use `<date the fan entered>_<venue they typed>`.

### QR code at gigs

`https://asoftfocus.com/submit-video?gig=2026-10-24-8-bit-bar` pre-selects that gig
(the id is the gig's `id` in gigs-data.json).

## Modes

| Where | Storage bound? | Behaviour |
|---|---|---|
| `*.asoftfocus.pages.dev` preview / localhost | no | **Demo**: real upload flow, chunks discarded, Turnstile test keys |
| preview / localhost | yes | Real storage, Turnstile test keys |
| asoftfocus.com | needs all switches | Closed ("not open yet") until bucket + Turnstile + signing secret + `FAN_VIDEO_UPLOADS_OPEN=true` |

## Go-live checklist (after the card is on the Cloudflare account)

1. **R2**: Dashboard → R2 → enable (needs a payment method; free up to 10 GB-month).
   `wrangler r2 bucket create asoftfocus-fan-videos --location oc`
2. **Bind it**: Pages project `asoftfocus` → Settings → Bindings → R2 → `FAN_VIDEOS` = `asoftfocus-fan-videos`
   (Production and Preview).
3. **Turnstile**: Dashboard → Turnstile → Add widget "asoftfocus.com fan videos", hostnames
   `asoftfocus.com`, `www.asoftfocus.com`, `asoftfocus.pages.dev`; Managed mode (free).
   Set `TURNSTILE_SITE_KEY` (variable) and `TURNSTILE_SECRET_KEY` (secret) on the Pages project.
4. **Signing secret**: `openssl rand -hex 32` → `wrangler pages secret put UPLOAD_SIGNING_SECRET --project-name=asoftfocus`
5. **Notifications**: deploy `notify-apps-script.gs` (instructions inside), then set
   `NOTIFY_WEBHOOK_URL` + `NOTIFY_WEBHOOK_SECRET`.
6. **Drive copy**: `brew install rclone`; `rclone config` → remote `asf-r2` (S3 / Cloudflare,
   R2 API token with *Object Read only* on the bucket) and `asf-drive` (Google Drive, Kyle's login).
   Test with `--dry-run`, then schedule hourly via launchd.
7. **Lifecycle rule** (optional): R2 bucket → abort incomplete multipart uploads after 7 days (default).
8. Test on a real iPhone (4G/5G, 1 GB+ 4K clip, lock screen mid-way, flight-mode mid-way).
9. Replace DRAFT consent wording + privacy note with approved text; bump `CONSENT_VERSION`.
10. Merge branch to main, set `FAN_VIDEO_UPLOADS_OPEN=true`, deploy, then add the
    "Submit your video" link/button where Kyle wants it.

## Costs

R2: free to 10 GB-month, then US$0.015/GB-month (200 GB ≈ US$3/month). Egress free.
Pages Functions: free plan allows 100,000 requests/day; a 1 GB video ≈ 100 chunk requests.
Turnstile, Apps Script, rclone: free.
