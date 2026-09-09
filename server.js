require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// ============================================================
// تشخیص نوع لینک: اسپاتیفای یا دیزر
// ============================================================
function detectSource(rawUrl) {
  const url = (rawUrl || '').trim();
  if (!url) return null;

  const spotifyMatch = url.match(/(?:open\.spotify\.com\/playlist\/|spotify:playlist:)([a-zA-Z0-9]+)/);
  if (spotifyMatch) return { type: 'spotify', id: spotifyMatch[1] };

  const deezerMatch = url.match(/deezer\.com\/(?:[a-z]{2}\/)?playlist\/(\d+)/);
  if (deezerMatch) return { type: 'deezer', id: deezerMatch[1] };

  return null;
}

// ============================================================
// مسیر ۱ (اصلی، بدون نیاز به کلید): خوندن صفحه‌ی عمومی پلی‌لیست اسپاتیفای
// این یه روش غیررسمیه: صفحه رو مثل یه مرورگر می‌گیریم و از بین دیتای
// تعبیه‌شده‌ی توش (JSON-LD / Next.js data) اسم آهنگ و خواننده رو درمیاریم.
// چون رسمی نیست ممکنه یه روز اسپاتیفای ساختار صفحه رو عوض کنه و این بشکنه؛
// یا ممکنه فقط بخشی از آهنگ‌های پلی‌لیست‌های خیلی بزرگ رو بگیره.
// ============================================================
async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) return null;
  return res.text();
}

function extractFromHtml(html) {
  const tracks = [];
  const seen = new Set();

  // روش ۱: بلوک‌های JSON-LD (application/ld+json) که برای سئو تو صفحه هست
  const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  for (const block of ldBlocks) {
    try {
      collectMusicRecordings(JSON.parse(block[1]), tracks, seen);
    } catch (e) {
      /* رد شو */
    }
  }

  // روش ۲: دیتای Next.js که تو __NEXT_DATA__ تعبیه شده (هم تو صفحه‌ی اصلی، هم embed)
  if (tracks.length === 0) {
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      try {
        collectMusicRecordings(JSON.parse(nextDataMatch[1]), tracks, seen);
      } catch (e) {
        /* رد شو */
      }
    }
  }

  // روش ۳: هر بلوک <script type="application/json">...</script> دیگه‌ای تو صفحه
  if (tracks.length === 0) {
    const jsonBlocks = [...html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)];
    for (const block of jsonBlocks) {
      try {
        collectMusicRecordings(JSON.parse(block[1]), tracks, seen);
      } catch (e) {
        /* رد شو */
      }
    }
  }

  return tracks;
}

async function scrapeSpotifyPlaylist(playlistId) {
  // اول صفحه‌ی embed رو امتحان می‌کنیم (ساختار ساده‌تر و پایدارتری داره،
  // چون همینو برای نمایش پلی‌لیست تو iframeِ سایت‌های دیگه استفاده می‌کنن)
  const embedHtml = await fetchHtml(`https://open.spotify.com/embed/playlist/${playlistId}`);
  if (embedHtml) {
    const fromEmbed = extractFromHtml(embedHtml);
    if (fromEmbed.length > 0) return fromEmbed;
  }

  // اگه جواب نداد، صفحه‌ی معمولی رو امتحان می‌کنیم
  const mainHtml = await fetchHtml(`https://open.spotify.com/playlist/${playlistId}`);
  if (!mainHtml) {
    throw new Error('دسترسی به صفحه‌ی پلی‌لیست ممکن نشد. مطمئن شو پلی‌لیست عمومیه.');
  }
  return extractFromHtml(mainHtml);
}

// به‌صورت بازگشتی تو یه ساختار JSON دنبال آبجکت‌های آهنگ می‌گرده
function collectMusicRecordings(node, out, seen, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return;

  if (Array.isArray(node)) {
    for (const item of node) collectMusicRecordings(item, out, seen, depth + 1);
    return;
  }

  const looksLikeSchemaTrack = node['@type'] === 'MusicRecording' && node.name;
  const looksLikeSpotifyTrack =
    typeof node.name === 'string' && Array.isArray(node.artists) && node.artists[0]?.name;
  // فرمت صفحه‌ی embed: هر آیتم trackList معمولاً { type:'track', title, subtitle, uri }
  const looksLikeEmbedTrack =
    typeof node.title === 'string' &&
    typeof node.subtitle === 'string' &&
    (node.type === 'track' || (typeof node.uri === 'string' && node.uri.includes(':track:')));

  if (looksLikeSchemaTrack) {
    const artistField = node.byArtist;
    const artistName = Array.isArray(artistField)
      ? artistField.map((a) => a.name).filter(Boolean).join(', ')
      : artistField?.name || '';
    addTrack(node.name, artistName, out, seen);
  } else if (looksLikeSpotifyTrack) {
    const artistName = node.artists.map((a) => a.name).filter(Boolean).join(', ');
    addTrack(node.name, artistName, out, seen);
  } else if (looksLikeEmbedTrack) {
    addTrack(node.title, node.subtitle, out, seen);
  }

  for (const key in node) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      collectMusicRecordings(node[key], out, seen, depth + 1);
    }
  }
}

function addTrack(name, artists, out, seen) {
  if (!name) return;
  const key = `${name}::${artists}`.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ name, artists: artists || '' });
}

// ============================================================
// مسیر ۲ (اختیاری): API رسمی اسپاتیفای، فقط اگه تو .env کلید گذاشته باشی
// و اکانتِ صاحبِ اپ پریمیوم داشته باشه. اگه کلید نداشته باشی این مسیر رد می‌شه.
// ============================================================
let cachedToken = null;
let tokenExpiresAt = 0;

async function getSpotifyToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 5000) return cachedToken;
  if (!CLIENT_ID || !CLIENT_SECRET) return null;

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) return null;

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function fetchViaOfficialApi(playlistId) {
  const token = await getSpotifyToken();
  if (!token) return null;

  const tracks = [];
  let url =
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&` +
    `fields=next,items(track(id,name,preview_url,artists(name),album(images)))`;

  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null; // اگه رسمی جواب نداد، بی‌سروصدا برمی‌گردیم به روش scrape
    const data = await res.json();
    for (const item of data.items || []) {
      const t = item.track;
      if (!t || !t.id) continue;
      tracks.push({
        id: t.id,
        name: t.name,
        artists: (t.artists || []).map((a) => a.name).join(', '),
        image: t.album?.images?.[0]?.url || null,
        preview: t.preview_url || null,
      });
    }
    url = data.next;
  }
  return tracks;
}

// ============================================================
// دیزر: هم برای گرفتن preview آهنگ‌های اسپاتیفای (با جستجو)، هم برای
// خوندن مستقیم پلی‌لیست‌های خودِ دیزر (که API رسمیش بدون نیاز به کلید کار می‌کنه)
// ============================================================
async function fetchDeezerPlaylist(playlistId) {
  const res = await fetch(`https://api.deezer.com/playlist/${playlistId}`);
  if (!res.ok) throw new Error(`گرفتن پلی‌لیست دیزر شکست خورد (${res.status}).`);
  const data = await res.json();
  if (data.error) throw new Error('این پلی‌لیست دیزر پیدا نشد یا خصوصیه.');

  return (data.tracks?.data || []).map((t) => ({
    id: `dz-${t.id}`,
    name: t.title,
    artists: t.artist?.name || '',
    image: t.album?.cover_medium || null,
    preview: t.preview || null,
  }));
}

async function searchDeezerPreview(name, artists) {
  try {
    const q = encodeURIComponent(`${name} ${artists}`);
    const res = await fetch(`https://api.deezer.com/search?q=${q}&limit=1`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.data && data.data[0] ? data.data[0] : null;
  } catch (e) {
    return null;
  }
}

async function fillPreviewsFromDeezer(tracks) {
  const BATCH = 5;
  for (let i = 0; i < tracks.length; i += BATCH) {
    const batch = tracks.slice(i, i + BATCH).filter((t) => !t.preview);
    await Promise.all(
      batch.map(async (t) => {
        const hit = await searchDeezerPreview(t.name, t.artists);
        if (hit && hit.preview) {
          t.preview = hit.preview;
          if (!t.image && hit.album?.cover_medium) t.image = hit.album.cover_medium;
        }
      })
    );
  }
  return tracks;
}

// ============================================================
// روت اصلی
// ============================================================
app.get('/api/playlist', async (req, res) => {
  try {
    const source = detectSource(req.query.url || '');
    if (!source) {
      return res.status(400).json({
        error: 'لینک معتبر نیست. یه لینک پلی‌لیست از open.spotify.com یا deezer.com بذار.',
      });
    }

    let tracks = [];

    if (source.type === 'deezer') {
      tracks = await fetchDeezerPlaylist(source.id);
    } else {
      // اول تلاش با API رسمی (اگه کلید داری و اکانتش پریمیومه)
      tracks = (await fetchViaOfficialApi(source.id)) || [];

      // اگه رسمی جواب نداد، برو سراغ scrape + جستجوی دیزر
      if (tracks.length === 0) {
        const scraped = await scrapeSpotifyPlaylist(source.id);
        if (scraped.length === 0) {
          throw new Error(
            'نتونستم آهنگ‌های این پلی‌لیست رو بخونم. مطمئن شو پلی‌لیست عمومیه، یا به‌جاش لینک یه پلی‌لیست از دیزر رو امتحان کن.'
          );
        }
        tracks = scraped.map((t, i) => ({
          id: `sp-${i}-${t.name}`,
          name: t.name,
          artists: t.artists,
          image: null,
          preview: null,
        }));
      }
    }

    tracks = await fillPreviewsFromDeezer(tracks);

    const playable = tracks.filter((t) => t.preview);
    const skipped = tracks.length - playable.length;

    if (playable.length < 4) {
      throw new Error('این پلی‌لیست به اندازه‌ی کافی آهنگ قابل‌پخش نداره (حداقل ۴ تا لازمه).');
    }

    res.json({ tracks: playable, total: tracks.length, skipped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'خطای داخلی سرور' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
