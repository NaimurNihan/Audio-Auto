export interface SrtCue {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
}

function timestampToSeconds(ts: string): number {
  const m = ts
    .trim()
    .match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) {
    throw new Error(`Invalid SRT timestamp: ${ts}`);
  }
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const ms = Number(m[4]);
  return h * 3600 + min * 60 + s + ms / 1000;
}

export function parseSrt(content: string): SrtCue[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  const blocks = normalized.split(/\n\s*\n/);
  const cues: SrtCue[] = [];

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;
    const lines = block.split("\n");
    let cursor = 0;

    // Skip optional numeric index
    if (lines[cursor] && /^\d+$/.test(lines[cursor]!.trim())) {
      cursor++;
    }

    const timeLine = lines[cursor];
    if (!timeLine) continue;
    const tm = timeLine.match(
      /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/,
    );
    if (!tm) continue;
    cursor++;

    const text = lines.slice(cursor).join("\n").trim();
    const startSec = timestampToSeconds(tm[1]!);
    const endSec = timestampToSeconds(tm[2]!);
    if (endSec <= startSec) continue;

    cues.push({
      index: cues.length + 1,
      startSec,
      endSec,
      text,
    });
  }

  return cues;
}
