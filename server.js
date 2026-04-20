import express from 'express';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { YoutubeTranscript } from 'youtube-transcript/dist/youtube-transcript.esm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;

app.use(express.static(__dirname));

// 문장 부호 기준으로 세그먼트 병합
function groupSubtitles(items) {
  const MIN_DUR = 1.5; // 이보다 짧으면 다음 세그먼트와 합침
  const MAX_DUR = 15;  // 이보다 길면 강제 끊기
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
    const dur = buf[buf.length - 1].end - buf[0].start;
    const text = buf.map(s => s.text).join(' ').trimEnd();
    const endsOnSentence = /[.?!]["')\]]?$/.test(text);

    if (dur >= MAX_DUR) {
      flush();
    } else if (endsOnSentence && dur >= MIN_DUR) {
      flush();
    }
  }
  flush();
  return groups;
}

app.get('/api/transcript', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) {
    return res.status(400).json({ error: 'videoId 파라미터가 필요합니다' });
  }

  console.log(`[API] Fetching transcript for: ${videoId}`);

  try {
    // 영어 자막 우선, 없으면 첫 번째 자막 사용
    let items = null;
    try {
      items = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
    } catch (_) {
      items = await YoutubeTranscript.fetchTranscript(videoId);
    }

    if (!items || items.length === 0) {
      return res.status(404).json({ error: '자막을 찾을 수 없습니다' });
    }

    // youtube-transcript: { text, duration(ms), offset(ms) }
    const raw = items.map(item => ({
      start: item.offset / 1000,
      end:   (item.offset + Math.max(item.duration || 1000, 300)) / 1000,
      text:  item.text.replace(/\n/g, ' ').trim(),
    })).filter(s => s.text.length > 0);

    const subs = groupSubtitles(raw);

    console.log(`[API] Returning ${subs.length} segments`);
    res.json({ subs });
  } catch (err) {
    console.error('[API] Error:', err.message);
    const msg = err.message.includes('Could not find') || err.message.includes('No transcripts')
      ? '이 영상에는 자막이 없거나 비활성화되어 있습니다'
      : err.message;
    res.status(500).json({ error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`YouTube Shadowing server running at http://localhost:${PORT}`);
});
