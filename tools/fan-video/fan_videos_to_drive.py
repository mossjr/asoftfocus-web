#!/usr/bin/env python3
"""
Copy new fan videos from Cloudflare R2 into Google Drive, one folder per gig.

    R2   asoftfocus-fan-videos/inbox/<gig>/<file>.mov (+ .json record)
    -->  Drive "A Soft Focus — Fan Videos"/<gig>/<file>.mov (+ .json record)
    and  Drive "A Soft Focus — Fan Videos"/submissions-log.csv  (every received clip)

Each clip is copied once. If you move, rename or delete it in Drive afterwards it is
NOT copied again (a state file remembers what was done). Originals stay in R2 as the
backup until we decide on a clean-up policy.

Needs rclone (`brew install rclone`, free) with two remotes set up once:
    asf-r2     type s3, provider Cloudflare, R2 API token (read-only is enough)
    asf-drive  type drive, signed in as the Google account that should own the files

Usage:
    python3 tools/fan-video/fan_videos_to_drive.py            # copy new clips
    python3 tools/fan-video/fan_videos_to_drive.py --dry-run  # just show what it would do

Environment overrides (mainly for testing):
    RCLONE, FAN_R2_ROOT, FAN_DRIVE_ROOT, FAN_SYNC_STATE
"""
import argparse
import csv
import io
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

RCLONE = os.environ.get("RCLONE", "rclone")
R2_ROOT = os.environ.get("FAN_R2_ROOT", "asf-r2:asoftfocus-fan-videos/inbox")
DRIVE_ROOT = os.environ.get("FAN_DRIVE_ROOT", "asf-drive:A Soft Focus — Fan Videos")
STATE_FILE = os.path.expanduser(os.environ.get("FAN_SYNC_STATE", "~/.config/asoftfocus/fan-video-sync-state.json"))
STALE_AFTER = timedelta(days=8)  # R2 discards unfinished uploads after 7 days

CSV_FIELDS = ["completedAt", "gigFolder", "gigLabel", "name", "instagram", "facebook", "email",
              "sizeMB", "consentVersion", "key", "driveCopiedAt"]


def rclone(*args, capture=True, data=None):
    cmd = [RCLONE, *args]
    r = subprocess.run(cmd, input=data, capture_output=capture, check=False)
    if r.returncode != 0:
        err = r.stderr.decode(errors="replace") if capture and r.stderr else ""
        raise RuntimeError(f"rclone {' '.join(args[:2])} failed ({r.returncode}): {err.strip()[:400]}")
    return r.stdout if capture else b""


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return {"copied": {}}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2, sort_keys=True)
    os.replace(tmp, STATE_FILE)


def parse_time(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    listing = json.loads(rclone("lsjson", "-R", "--files-only", "--no-mimetype", R2_ROOT) or b"[]")
    paths = {e["Path"]: e for e in listing}
    sidecars = sorted(p for p in paths if p.endswith(".json"))

    state = load_state()
    copied = state.setdefault("copied", {})
    received, stale, new = [], [], 0
    now = datetime.now(timezone.utc)

    for sc in sidecars:
        rec = json.loads(rclone("cat", f"{R2_ROOT}/{sc}"))
        video_rel = sc[: -len(".json")]
        status = rec.get("status")
        if status != "received":
            started = parse_time(rec.get("submittedAt"))
            if started and now - started > STALE_AFTER:
                stale.append(video_rel)
            continue
        if video_rel not in paths:
            print(f"! record without video (skipped): {video_rel}")
            continue
        received.append((video_rel, rec))
        if video_rel in copied:
            continue
        gig_dir = video_rel.split("/")[0]
        print(f"{'[dry-run] ' if args.dry_run else ''}copy {video_rel}  ({paths[video_rel]['Size'] / 1048576:.0f} MB)")
        if not args.dry_run:
            rclone("copyto", f"{R2_ROOT}/{video_rel}", f"{DRIVE_ROOT}/{video_rel}", capture=True)
            rclone("copyto", f"{R2_ROOT}/{sc}", f"{DRIVE_ROOT}/{sc}", capture=True)
            copied[video_rel] = now.isoformat(timespec="seconds")
            save_state(state)  # save after every clip so a crash never re-copies
        new += 1

    # Running log of every received clip (rebuilt each run, newest first).
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=CSV_FIELDS)
    w.writeheader()
    for video_rel, rec in sorted(received, key=lambda x: x[1].get("completedAt", ""), reverse=True):
        w.writerow({
            "completedAt": rec.get("completedAt", ""),
            "gigFolder": rec.get("gigFolder", ""),
            "gigLabel": rec.get("gigLabel", ""),
            "name": rec.get("name", ""),
            "instagram": ("@" + rec["instagram"]) if rec.get("instagram") else "",
            "facebook": rec.get("facebook", ""),
            "email": rec.get("email", ""),
            "sizeMB": round((rec.get("storedSize") or rec.get("file", {}).get("size") or 0) / 1048576),
            "consentVersion": rec.get("consentVersion", ""),
            "key": rec.get("key", ""),
            "driveCopiedAt": copied.get(video_rel, ""),
        })
    if not args.dry_run and received:
        rclone("rcat", f"{DRIVE_ROOT}/submissions-log.csv", data=buf.getvalue().encode("utf-8"))

    print(f"{new} new clip(s) {'would be ' if args.dry_run else ''}copied; {len(received)} received in total.")
    if stale:
        print(f"{len(stale)} abandoned upload record(s) older than 8 days (safe to delete in R2):")
        for s in stale:
            print("   ", s + ".json")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except FileNotFoundError:
        print("rclone not found. Install it with: brew install rclone", file=sys.stderr)
        sys.exit(2)
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
