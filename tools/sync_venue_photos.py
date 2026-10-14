#!/usr/bin/env python3
"""Sync venue photos from ../venue-photos/ into the website.

Kyle drops photos (JPG / PNG / HEIC / WebP, any size) into one folder per venue:

    /Users/kyledavis/Projects/asoftfocus-web/venue-photos/
        8-Bit Bar/
        Beach House Hotel/
        Hervey Bay Boat Club/
        _Placeholder (us playing)/   <- fallback for venues with no photos

This script:
  * converts every photo to an optimised WebP (max 1600px wide, quality 80),
    with EXIF orientation applied and ALL metadata (EXIF/GPS/XMP) stripped
  * writes them to site/assets/images/venues/<slug>/  (slug = folder name,
    lowercased and hyphenated; "_Placeholder ..." -> "_placeholder")
  * writes site/assets/images/venues/manifest.json:
        {"8-bit-bar": {"name": "8-Bit Bar", "images": [{"src": ..., "credit": ...}]}, ...,
         "_placeholder": {...}}
    credit comes from "_@handle" in the file name, otherwise "📷 A Soft Focus"
  * is idempotent: only new/changed photos are re-encoded (state is kept in
    venue-photos/.sync-state.json, outside the repo); web copies whose source
    photo was deleted are removed
  * never copies or commits the raw venue-photos folder itself

Only photos directly inside a venue folder are used; sub-folders (e.g.
"originals/") and files starting with "." are ignored.

Usage (from the site/ folder):
    python3 tools/sync_venue_photos.py           # sync
    python3 tools/sync_venue_photos.py --force   # re-encode everything
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata

from PIL import Image, ImageOps

SITE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_ROOT = os.path.join(os.path.dirname(SITE_DIR), "venue-photos")
OUT_ROOT = os.path.join(SITE_DIR, "assets", "images", "venues")
MANIFEST = os.path.join(OUT_ROOT, "manifest.json")
STATE = os.path.join(SRC_ROOT, ".sync-state.json")

MAX_WIDTH = 1600
QUALITY = 80
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".tif", ".tiff"}
DEFAULT_CREDIT = "📷 A Soft Focus"
PLACEHOLDER_SLUG = "_placeholder"
HANDLE_RE = re.compile(r"_@([A-Za-z0-9._]+)$")


def slugify(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s or "venue"


def venue_slug(folder):
    if folder.lower().startswith("_placeholder"):
        return PLACEHOLDER_SLUG
    return slugify(folder)


def parse_photo_name(filename):
    """'boat-club_@shawshotsvideo.jpg' -> ('boat-club', '📷 @shawshotsvideo')"""
    stem = os.path.splitext(filename)[0]
    m = HANDLE_RE.search(stem)
    if m:
        return slugify(stem[: m.start()]) or "photo", f"📷 @{m.group(1)}"
    return slugify(stem) or "photo", DEFAULT_CREDIT


def file_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def open_image(path):
    """Open any supported photo; HEIC goes through macOS sips (keeps the orientation tag)."""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".heic", ".heif"):
        try:
            import pillow_heif  # optional
            pillow_heif.register_heif_opener()
            return Image.open(path)
        except ImportError:
            pass
        if not shutil.which("sips"):
            raise RuntimeError("HEIC needs macOS 'sips' or 'pip install pillow-heif'")
        tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
        tmp.close()
        subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "95", path, "--out", tmp.name],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        img = Image.open(tmp.name)
        img.load()
        os.unlink(tmp.name)
        return img
    return Image.open(path)


def convert(src, dst):
    img = open_image(src)
    img = ImageOps.exif_transpose(img)  # bake in orientation
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
    if img.width > MAX_WIDTH:
        img = img.resize((MAX_WIDTH, round(img.height * MAX_WIDTH / img.width)), Image.Resampling.LANCZOS)
    # Copy pixels into a fresh image so no EXIF/GPS/XMP/ICC metadata can carry over.
    clean = Image.new(img.mode, img.size)
    clean.paste(img)
    tmp = dst + ".tmp"
    clean.save(tmp, "WEBP", quality=QUALITY, method=6)
    os.replace(tmp, dst)
    return clean.size


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="re-encode every photo")
    args = ap.parse_args()

    if not os.path.isdir(SRC_ROOT):
        sys.exit(f"venue-photos folder not found: {SRC_ROOT}")
    os.makedirs(OUT_ROOT, exist_ok=True)

    state = {} if args.force else load_json(STATE, {})
    new_state, manifest, expected = {}, {}, set()
    converted = skipped = 0
    errors = []

    for folder in sorted(os.listdir(SRC_ROOT)):
        src_dir = os.path.join(SRC_ROOT, folder)
        if folder.startswith(".") or not os.path.isdir(src_dir):
            continue
        slug = venue_slug(folder)
        name = "Placeholder" if slug == PLACEHOLDER_SLUG else folder
        out_dir = os.path.join(OUT_ROOT, slug)
        images, used = [], set()

        for fn in sorted(os.listdir(src_dir)):
            src = os.path.join(src_dir, fn)
            if fn.startswith(".") or not os.path.isfile(src) or os.path.splitext(fn)[1].lower() not in EXTS:
                continue
            base, credit = parse_photo_name(fn)
            out_name, n = base + ".webp", 2
            while out_name in used:  # e.g. photo.jpg + photo.png
                out_name, n = f"{base}-{n}.webp", n + 1
            used.add(out_name)
            dst = os.path.join(out_dir, out_name)
            rel_src = os.path.relpath(src, SRC_ROOT)
            rel_dst = os.path.relpath(dst, SITE_DIR).replace(os.sep, "/")
            expected.add(os.path.abspath(dst))

            st = os.stat(src)
            prev = state.get(rel_src, {})
            if prev.get("mtime") == st.st_mtime and prev.get("size") == st.st_size and prev.get("dst") == rel_dst:
                digest = prev["sha256"]
            else:
                digest = file_hash(src)
            entry = {"mtime": st.st_mtime, "size": st.st_size, "sha256": digest, "dst": rel_dst}

            if prev.get("sha256") == digest and prev.get("dst") == rel_dst and os.path.exists(dst):
                skipped += 1
                entry["width"], entry["height"] = prev.get("width"), prev.get("height")
            else:
                try:
                    os.makedirs(out_dir, exist_ok=True)
                    entry["width"], entry["height"] = convert(src, dst)
                    converted += 1
                    print(f"  converted  {rel_src}  ->  {rel_dst}")
                except Exception as exc:  # keep going; report at the end
                    errors.append(f"{rel_src}: {exc}")
                    expected.discard(os.path.abspath(dst))
                    continue
            new_state[rel_src] = entry
            images.append({"src": rel_dst, "credit": credit,
                           "width": entry.get("width"), "height": entry.get("height")})

        manifest[slug] = {"name": name, "images": images}

    # Remove web copies whose source photo was deleted (only inside managed slug folders).
    removed = 0
    for slug_dir in sorted(os.listdir(OUT_ROOT)):
        d = os.path.join(OUT_ROOT, slug_dir)
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            p = os.path.abspath(os.path.join(d, fn))
            if fn.endswith(".webp") and p not in expected:
                os.remove(p)
                removed += 1
                print(f"  removed    {os.path.relpath(p, SITE_DIR)}")
        if not os.listdir(d):
            os.rmdir(d)

    ordered = {k: manifest[k] for k in sorted(manifest) if k != PLACEHOLDER_SLUG}
    if PLACEHOLDER_SLUG in manifest:
        ordered[PLACEHOLDER_SLUG] = manifest[PLACEHOLDER_SLUG]
    with open(MANIFEST + ".tmp", "w", encoding="utf-8") as f:
        json.dump(ordered, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(MANIFEST + ".tmp", MANIFEST)
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(new_state, f, indent=2)

    print(f"Venue photos: {converted} converted, {skipped} unchanged, {removed} removed, "
          f"{len(ordered)} venue entries -> {os.path.relpath(MANIFEST, SITE_DIR)}")
    for slug, v in ordered.items():
        print(f"  {slug:24s} {len(v['images'])} photo(s)")
    if PLACEHOLDER_SLUG not in ordered or not ordered[PLACEHOLDER_SLUG]["images"]:
        print("  WARNING: no placeholder photo — venues without photos will show the branded card")
    if errors:
        print("ERRORS:\n  " + "\n  ".join(errors))
        sys.exit(1)


if __name__ == "__main__":
    main()
