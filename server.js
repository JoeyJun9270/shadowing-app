import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { Innertube } from 'youtubei.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

// Innertube 세션 (요청마다 생성하면 느리므로 singleton)
let yt = null;
async function getInnertube() {
  if (!yt) {
    console.log('[Innertube] Creating session...');
    yt = await Innertube.create({ generate_session_locally: true });
    console.log('[Innertube] Session ready');
  }
  return yt;
}

// timedtext XML 파서: <text start="..." dur="...">...</text>
function parseTimedtextXml(xml) {
  const items = [];
  const re = /<text[^>]+start="([^"]+)"[^>]+dur="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const start = parseFloat(m[1]);
    const dur   = parseFloat(m[2]);
    const text  = m[3]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
      .replace(/\n/g, ' ').trim();
    if (text) items.push({ start, end: start + Math.max(dur, 0.3), text });
  }
  return items;
}

// timedtext JSON3 파서
function parseJson3(data) {
  if (!data?.events) return [];
  return data.events
    .filter(e => e.segs)
    .map(e => ({
      start: e.tStartMs / 1000,
      end:   (e.tStartMs + Math.max(e.dDurationMs || 1000, 300)) / 1000,
      text:  e.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim(),
    }))
    .filter(s => s.text.length > 0);
}

// 문장 부호 기준 세그먼트 병합
function groupSubtitles(items) {
  const MIN_DUR = 1.5, MAX_DUR = 15;
  const groups = [];
  let buf = [];

  const flush = () => {
    if (!buf.length) return;
    groups.push({
      start: buf[0].start,
      end:   buf[buf.length - 1].end,
      text:  buf.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim(),
    });
    buf = [];
  };

  for (const item of items) {
    buf.push(item);
    const dur  = buf[buf.length - 1].end - buf[0].start;
    const text = buf.map(s => s.text).join(' ').trimEnd();
    const endsOnSentence = /[.?!]["')\]]?$/.test(text);
    if (dur >= MAX_DUR)                        flush();
    else if (endsOnSentence && dur >= MIN_DUR) flush();
  }
  flush();
  return groups;
}

// timedtext URL fetch (XML 우선, 실패 시 JSON3)
async function fetchTimedtext(baseUrl) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.youtube.com/',
  };

  // 1차: XML 포맷
  const xmlRes = await fetch(baseUrl, { headers, signal: AbortSignal.timeout(10000) });
  if (xmlRes.ok) {
    const xml = await xmlRes.text();
    if (xml && xml.length > 20) {
      const parsed = parseTimedtextXml(xml);
      if (parsed.length) { console.log('[Timedtext] XML OK:', parsed.length, 'items'); return parsed; }
    }
  }

  // 2차: JSON3 포맷
  const jsonRes = await fetch(baseUrl + '&fmt=json3', { headers, signal: AbortSignal.timeout(10000) });
  if (jsonRes.ok) {
    const text = await jsonRes.text();
    if (text && text.length > 10) {
      try {
        const parsed = parseJson3(JSON.parse(text));
        if (parsed.length) { console.log('[Timedtext] JSON3 OK:', parsed.length, 'items'); return parsed; }
      } catch (_) {}
    }
  }

  return [];
}

app.get('/api/haskey', (req, res) => {
  res.json({ hasKey: !!process.env.YOUTUBE_API_KEY });
});

app.get('/api/transcript', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: 'videoId 파라미터가 필요합니다' });

  console.log(`[API] Fetching transcript: ${videoId}`);

  // ── 방법 1: youtubei.js Innertube ─────────────────────────────────────────
  try {
    const innertube = await getInnertube();
    const info = await innertube.getInfo(videoId);
    const tracks = info.captions?.caption_tracks ?? [];
    console.log(`[Innertube] ${tracks.length} caption tracks found`);

    if (tracks.length > 0) {
      const selected =
        tracks.find(t => t.language_code === 'en') ||
        tracks.find(t => t.language_code?.startsWith('en')) ||
        tracks[0];

      console.log(`[Innertube] Selected: ${selected.language_code} (kind: ${selected.kind ?? 'manual'})`);

      const raw = await fetchTimedtext(selected.base_url);
      if (raw.length > 0) {
        const subs = groupSubtitles(raw);
        console.log(`[API] Innertube success: ${subs.length} segments`);
        return res.json({ subs });
      }
      console.warn('[Innertube] timedtext returned empty, falling back...');
    }
  } catch (e) {
    console.warn('[Innertube] failed:', e.message?.slice(0, 120));
    // 세션 리셋 (다음 요청에서 재생성)
    yt = null;
  }

  // ── 방법 2: YouTube Data API v3 fallback ──────────────────────────────────
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: '자막 로드 실패: Innertube 접근 불가, API Key도 없습니다.' });
  }

  try {
    const listUrl = `https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${videoId}&key=${apiKey}`;
    const listRes = await fetch(listUrl, { signal: AbortSignal.timeout(10000) });
    const listData = await listRes.json();

    if (listData.error) throw new Error(`YouTube API: ${listData.error.message}`);

    const tracks = listData.items ?? [];
    console.log(`[DataAPI] ${tracks.length} tracks`);
    if (!tracks.length) return res.status(404).json({ error: '자막을 찾을 수 없습니다' });

    const selected =
      tracks.find(t => t.snippet.language === 'en') ||
      tracks.find(t => t.snippet.language?.startsWith('en')) ||
      tracks[0];

    const lang = selected.snippet.language;
    const isAsr = selected.snippet.trackKind === 'ASR';
    const params = new URLSearchParams({ v: videoId, lang, fmt: 'json3' });
    if (isAsr) params.set('kind', 'asr');
    const timedtextUrl = `https://www.youtube.com/api/timedtext?${params}`;

    const subRes = await fetch(timedtextUrl, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }
    });
    if (!subRes.ok) throw new Error(`timedtext HTTP ${subRes.status}`);

    const subText = await subRes.text();
    if (!subText || subText.length < 10) throw new Error('timedtext 응답 비어있음');

    let raw;
    try { raw = parseJson3(JSON.parse(subText)); }
    catch (e) {
      console.error('[DataAPI] JSON parse fail, preview:', subText.slice(0, 200));
      throw new Error(`JSON 파싱 실패: ${e.message}`);
    }
    if (!raw.length) return res.status(404).json({ error: '자막 내용 없음' });

    const subs = groupSubtitles(raw);
    console.log(`[API] DataAPI fallback success: ${subs.length} segments`);
    return res.json({ subs });

  } catch (e) {
    console.error('[DataAPI] failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`YouTube Shadowing server running on port ${PORT}`);
  // 미리 Innertube 세션 준비
  getInnertube().catch(e => console.warn('[Innertube] Warmup failed:', e.message));
});
