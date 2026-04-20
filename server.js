import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

function splitLongItems(items) {
  const MAX_ITEM = 6;
  const result = [];
  for (const item of items) {
    const dur = item.end - item.start;
    if (dur <= MAX_ITEM) { result.push(item); continue; }
    // split on sentence boundaries, distribute time proportionally
    const parts = item.text.match(/[^.!?]+[.!?]+["')\]]?/g) || [item.text];
    const totalChars = parts.reduce((s, p) => s + p.length, 0);
    let offset = item.start;
    for (const part of parts) {
      const partDur = dur * (part.length / totalChars);
      result.push({ text: part.trim(), start: offset, end: offset + partDur });
      offset += partDur;
    }
  }
  return result;
}

function groupSubtitles(items) {
  const MIN_DUR = 1, MAX_DUR = 6, COMMA_DUR = 4;
  const groups = [];
  let buf = [];

  const flush = () => {
    if (!buf.length) return;
    groups.push({
      start: buf[0].start,
      end:   buf[buf.length - 1].end,
      text:  buf.map(s => s.text).join(' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim(),
    });
    buf = [];
  };

  for (const item of items) {
    buf.push(item);
    const dur  = buf[buf.length - 1].end - buf[0].start;
    const text = buf.map(s => s.text).join(' ').trimEnd();
    const endsOnSentence = /[.?!]["')\]]?$/.test(text);
    const endsOnComma    = /,["')\]]?$/.test(text);
    if (dur >= MAX_DUR)                        flush();
    else if (endsOnSentence && dur >= MIN_DUR) flush();
    else if (endsOnComma    && dur >= COMMA_DUR) flush();
  }
  flush();
  return groups;
}

app.get('/api/transcript', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: 'videoId 파라미터가 필요합니다' });

  const apiKey = process.env.SUPADATA_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'SUPADATA_API_KEY 환경변수가 설정되지 않았습니다' });

  console.log(`[API] Fetching transcript: ${videoId}`);

  try {
    const url = `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&lang=en`;
    const r = await fetch(url, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(15000),
    });

    if (!r.ok) {
      const body = await r.text();
      console.error(`[API] Supadata error ${r.status}:`, body.slice(0, 200));
      throw new Error(`Supadata API 오류: HTTP ${r.status}`);
    }

    const data = await r.json();
    console.log(`[API] Response keys: ${Object.keys(data).join(', ')}`);
    const transcript = data.transcript ?? data.content ?? [];

    if (!transcript.length) {
      return res.status(404).json({ error: '자막을 찾을 수 없습니다' });
    }

    console.log(`[API] Total items: ${transcript.length}`);
    console.log(`[API] First 3 raw:`, JSON.stringify(transcript.slice(0, 3)));

    const raw = transcript.map(t => ({
      text:  t.text.replace(/\n/g, ' ').trim(),
      start: t.offset / 1000,
      end:   (t.offset + t.duration) / 1000,
    })).filter(t => t.text.length > 0);

    console.log(`[API] First 3 mapped:`, JSON.stringify(raw.slice(0, 3)));

    const subs = groupSubtitles(splitLongItems(raw));
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
