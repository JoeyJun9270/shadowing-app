import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

// 서버에 API Key 설정 여부 확인
app.get('/api/haskey', (req, res) => {
  res.json({ hasKey: !!process.env.YOUTUBE_API_KEY });
});

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

function groupSubtitles(items) {
  const MIN_DUR = 1.5;
  const MAX_DUR = 15;
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

  for (let i = 0; i < items.length; i++) {
    buf.push(items[i]);
    const dur  = buf[buf.length - 1].end - buf[0].start;
    const text = buf.map(s => s.text).join(' ').trimEnd();
    const endsOnSentence = /[.?!]["')\]]?$/.test(text);

    if (dur >= MAX_DUR)                        flush();
    else if (endsOnSentence && dur >= MIN_DUR) flush();
  }
  flush();
  return groups;
}

app.get('/api/transcript', async (req, res) => {
  const { videoId } = req.query;
  const apiKey = req.query.apiKey || process.env.YOUTUBE_API_KEY;

  if (!videoId) {
    return res.status(400).json({ error: 'videoId 파라미터가 필요합니다' });
  }
  if (!apiKey) {
    return res.status(400).json({ error: 'API Key가 없습니다. 설정에서 YouTube API Key를 입력해주세요.' });
  }

  console.log(`[API] Fetching transcript for: ${videoId}`);

  try {
    // 1. YouTube Data API v3 — captions.list로 트랙 목록 조회
    const listUrl = `https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${videoId}&key=${apiKey}`;
    const listRes = await fetch(listUrl, { signal: AbortSignal.timeout(10000) });
    const listData = await listRes.json();

    if (listData.error) {
      console.error('[API] captions.list error:', listData.error.message);
      throw new Error(`YouTube API 오류: ${listData.error.message}`);
    }

    const tracks = listData.items || [];
    console.log(`[API] Found ${tracks.length} caption tracks`);

    if (!tracks.length) {
      return res.status(404).json({ error: '자막을 찾을 수 없습니다 (이 영상에 자막이 없거나 비공개입니다)' });
    }

    // 영어 트랙 우선, 없으면 첫 번째 트랙 사용
    const selected =
      tracks.find(t => t.snippet.language === 'en') ||
      tracks.find(t => t.snippet.language?.startsWith('en')) ||
      tracks[0];

    const lang  = selected.snippet.language;
    const isAsr = selected.snippet.trackKind === 'ASR';
    console.log(`[API] Selected track: lang=${lang}, kind=${selected.snippet.trackKind}`);

    // 2. timedtext URL로 자막 내용 서버에서 직접 fetch (CORS 없음)
    const params = new URLSearchParams({ v: videoId, lang, fmt: 'json3' });
    if (isAsr) params.set('kind', 'asr');
    const timedtextUrl = `https://www.youtube.com/api/timedtext?${params}`;

    console.log(`[API] Fetching timedtext: ${timedtextUrl}`);
    const subRes = await fetch(timedtextUrl, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!subRes.ok) {
      throw new Error(`timedtext 요청 실패: HTTP ${subRes.status}`);
    }

    const subText = await subRes.text();
    if (!subText || subText.length < 10) {
      throw new Error(`timedtext 응답이 비어있습니다 (length=${subText?.length ?? 0})`);
    }

    let subData;
    try {
      subData = JSON.parse(subText);
    } catch (e) {
      console.error('[API] JSON 파싱 실패. 응답 앞 200자:', subText.slice(0, 200));
      throw new Error(`자막 JSON 파싱 실패: ${e.message}`);
    }

    const raw  = parseJson3(subData);

    if (!raw.length) {
      return res.status(404).json({ error: '자막 내용을 파싱할 수 없습니다' });
    }

    const subs = groupSubtitles(raw);
    console.log(`[API] Returning ${subs.length} segments`);
    res.json({ subs });

  } catch (err) {
    console.error('[API] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`YouTube Shadowing server running on port ${PORT}`);
});
