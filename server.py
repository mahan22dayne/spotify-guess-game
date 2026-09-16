import os
import re
import json
from flask import Flask, request, jsonify, send_from_directory
import requests
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__, static_folder="public", static_url_path="")

CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID")
CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET")

HEADERS_BROWSER = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

SPOTIFY_RE = re.compile(r"(?:open\.spotify\.com/playlist/|spotify:playlist:)([a-zA-Z0-9]+)")
DEEZER_RE = re.compile(r"deezer\.com/(?:[a-z]{2}/)?playlist/(\d+)")


def detect_source(raw_url):
    url = (raw_url or "").strip()
    if not url:
        return None
    m = SPOTIFY_RE.search(url)
    if m:
        return {"type": "spotify", "id": m.group(1)}
    m = DEEZER_RE.search(url)
    if m:
        return {"type": "deezer", "id": m.group(1)}
    return None


LD_JSON_RE = re.compile(r'<script type="application/ld\+json">([\s\S]*?)</script>')
NEXT_DATA_RE = re.compile(r'<script id="__NEXT_DATA__" type="application/json">([\s\S]*?)</script>')
JSON_SCRIPT_RE = re.compile(r'<script[^>]*type="application/json"[^>]*>([\s\S]*?)</script>')


def fetch_html(url):
    try:
        res = requests.get(url, headers=HEADERS_BROWSER, timeout=15)
        if not res.ok:
            return None
        return res.text
    except requests.RequestException:
        return None


def collect_music_recordings(node, out, seen, depth=0):
    if depth > 12 or node is None:
        return

    if isinstance(node, list):
        for item in node:
            collect_music_recordings(item, out, seen, depth + 1)
        return

    if not isinstance(node, dict):
        return

    looks_like_schema_track = node.get("@type") == "MusicRecording" and node.get("name")
    artists_field = node.get("artists")
    looks_like_spotify_track = (
        isinstance(node.get("name"), str)
        and isinstance(artists_field, list)
        and len(artists_field) > 0
        and isinstance(artists_field[0], dict)
        and artists_field[0].get("name")
    )
    uri = node.get("uri")
    looks_like_embed_track = (
        isinstance(node.get("title"), str)
        and isinstance(node.get("subtitle"), str)
        and (node.get("type") == "track" or (isinstance(uri, str) and ":track:" in uri))
    )

    if looks_like_schema_track:
        by_artist = node.get("byArtist")
        if isinstance(by_artist, list):
            artist_name = ", ".join(a.get("name", "") for a in by_artist if a.get("name"))
        elif isinstance(by_artist, dict):
            artist_name = by_artist.get("name", "")
        else:
            artist_name = ""
        add_track(node.get("name"), artist_name, out, seen)
    elif looks_like_spotify_track:
        artist_name = ", ".join(a.get("name", "") for a in artists_field if a.get("name"))
        add_track(node.get("name"), artist_name, out, seen)
    elif looks_like_embed_track:
        add_track(node.get("title"), node.get("subtitle"), out, seen)

    for value in node.values():
        collect_music_recordings(value, out, seen, depth + 1)


def add_track(name, artists, out, seen):
    if not name:
        return
    key = f"{name}::{artists}".lower()
    if key in seen:
        return
    seen.add(key)
    out.append({"name": name, "artists": artists or ""})


def extract_from_html(html):
    tracks = []
    seen = set()

    for block in LD_JSON_RE.findall(html):
        try:
            collect_music_recordings(json.loads(block), tracks, seen)
        except (json.JSONDecodeError, TypeError):
            pass

    if not tracks:
        m = NEXT_DATA_RE.search(html)
        if m:
            try:
                collect_music_recordings(json.loads(m.group(1)), tracks, seen)
            except (json.JSONDecodeError, TypeError):
                pass

    if not tracks:
        for block in JSON_SCRIPT_RE.findall(html):
            try:
                collect_music_recordings(json.loads(block), tracks, seen)
            except (json.JSONDecodeError, TypeError):
                pass

    return tracks


def scrape_spotify_playlist(playlist_id):
    embed_html = fetch_html(f"https://open.spotify.com/embed/playlist/{playlist_id}")
    if embed_html:
        from_embed = extract_from_html(embed_html)
        if from_embed:
            return from_embed

    main_html = fetch_html(f"https://open.spotify.com/playlist/{playlist_id}")
    if not main_html:
        raise RuntimeError("دسترسی به صفحه‌ی پلی‌لیست ممکن نشد. مطمئن شو پلی‌لیست عمومیه.")
    return extract_from_html(main_html)


_cached_token = None
_token_expires_at = 0


def get_spotify_token():
    global _cached_token, _token_expires_at
    import time

    if _cached_token and time.time() < _token_expires_at - 5:
        return _cached_token
    if not CLIENT_ID or not CLIENT_SECRET:
        return None

    res = requests.post(
        "https://accounts.spotify.com/api/token",
        data={"grant_type": "client_credentials"},
        auth=(CLIENT_ID, CLIENT_SECRET),
        timeout=15,
    )
    if not res.ok:
        return None
    data = res.json()
    _cached_token = data["access_token"]
    _token_expires_at = time.time() + data["expires_in"]
    return _cached_token


def fetch_via_official_api(playlist_id):
    token = get_spotify_token()
    if not token:
        return None

    tracks = []
    url = (
        f"https://api.spotify.com/v1/playlists/{playlist_id}/tracks?limit=100&"
        "fields=next,items(track(id,name,preview_url,artists(name),album(images)))"
    )
    while url:
        res = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=15)
        if not res.ok:
            return None
        data = res.json()
        for item in data.get("items", []):
            t = item.get("track")
            if not t or not t.get("id"):
                continue
            images = t.get("album", {}).get("images") or []
            tracks.append(
                {
                    "id": t["id"],
                    "name": t["name"],
                    "artists": ", ".join(a["name"] for a in t.get("artists", [])),
                    "image": images[0]["url"] if images else None,
                    "preview": t.get("preview_url"),
                }
            )
        url = data.get("next")
    return tracks


def fetch_deezer_playlist(playlist_id):
    res = requests.get(f"https://api.deezer.com/playlist/{playlist_id}", timeout=15)
    if not res.ok:
        raise RuntimeError(f"گرفتن پلی‌لیست دیزر شکست خورد ({res.status_code}).")
    data = res.json()
    if data.get("error"):
        raise RuntimeError("این پلی‌لیست دیزر پیدا نشد یا خصوصیه.")

    tracks = []
    for t in data.get("tracks", {}).get("data", []):
        tracks.append(
            {
                "id": f"dz-{t['id']}",
                "name": t.get("title"),
                "artists": (t.get("artist") or {}).get("name", ""),
                "image": (t.get("album") or {}).get("cover_medium"),
                "preview": t.get("preview"),
            }
        )
    return tracks


def search_deezer_preview(name, artists):
    try:
        res = requests.get(
            "https://api.deezer.com/search",
            params={"q": f"{name} {artists}", "limit": 1},
            timeout=10,
        )
        if not res.ok:
            return None
        data = res.json()
        results = data.get("data") or []
        return results[0] if results else None
    except requests.RequestException:
        return None


def fill_previews_from_deezer(tracks):
    for t in tracks:
        if t.get("preview"):
            continue
        hit = search_deezer_preview(t.get("name", ""), t.get("artists", ""))
        if hit and hit.get("preview"):
            t["preview"] = hit["preview"]
            if not t.get("image") and hit.get("album", {}).get("cover_medium"):
                t["image"] = hit["album"]["cover_medium"]
    return tracks


@app.route("/api/playlist")
def api_playlist():
    try:
        source = detect_source(request.args.get("url", ""))
        if not source:
            return jsonify({"error": "لینک معتبر نیست. یه لینک پلی‌لیست از open.spotify.com یا deezer.com بذار."}), 400

        if source["type"] == "deezer":
            tracks = fetch_deezer_playlist(source["id"])
        else:
            tracks = fetch_via_official_api(source["id"]) or []
            if not tracks:
                scraped = scrape_spotify_playlist(source["id"])
                if not scraped:
                    raise RuntimeError(
                        "نتونستم آهنگ‌های این پلی‌لیست رو بخونم. مطمئن شو پلی‌لیست عمومیه، "
                        "یا به‌جاش لینک یه پلی‌لیست از دیزر رو امتحان کن."
                    )
                tracks = [
                    {
                        "id": f"sp-{i}-{t['name']}",
                        "name": t["name"],
                        "artists": t["artists"],
                        "image": None,
                        "preview": None,
                    }
                    for i, t in enumerate(scraped)
                ]

        tracks = fill_previews_from_deezer(tracks)
        playable = [t for t in tracks if t.get("preview")]
        skipped = len(tracks) - len(playable)

        if len(playable) < 4:
            raise RuntimeError("این پلی‌لیست به اندازه‌ی کافی آهنگ قابل‌پخش نداره (حداقل ۴ تا لازمه).")

        return jsonify({"tracks": playable, "total": len(tracks), "skipped": skipped})

    except Exception as err:
        print(f"Error: {err}")
        return jsonify({"error": str(err) or "خطای داخلی سرور"}), 500


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    app.run(host="0.0.0.0", port=port)
