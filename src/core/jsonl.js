/**
 * Streaming line reader tuned for very large append-only logs.
 *
 * Two things matter for a 1.5 GB corpus of session transcripts:
 *  1. never hold a whole file in memory;
 *  2. never JSON.parse a line you don't need — a cheap substring prefilter
 *     skips the ~85% of transcript lines that carry no usage block, which is
 *     the difference between a 20-second and a 3-minute refresh.
 *
 * `readLines` returns the byte offset of the last COMPLETE line so an
 * interrupted or still-being-written file can be resumed exactly.
 */
import fs from 'node:fs';

const NL = 0x0a;

/**
 * @param {string} file
 * @param {(line:string, offsetAfter:number)=>void} onLine
 * @param {{start?:number, must?:string[], chunkSize?:number, maxBytes?:number}} [opt]
 *   must: if given, a line is only decoded+delivered when it contains at least
 *         one of these ASCII substrings (checked on the raw buffer).
 * @returns {{offset:number, bytes:number, lines:number, delivered:number, truncated:boolean}}
 */
export function readLines(file, onLine, opt = {}) {
  const start = opt.start || 0;
  const chunkSize = opt.chunkSize || 1 << 20;
  const maxBytes = opt.maxBytes ?? Infinity;
  const must = (opt.must || []).map((s) => Buffer.from(s, 'latin1'));

  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    let pos = Math.min(start, stat.size);
    const limit = Math.min(stat.size, start + maxBytes);
    let buf = Buffer.alloc(0);
    let lineStart = pos;
    let lines = 0;
    let delivered = 0;
    let lastComplete = pos;
    const chunk = Buffer.allocUnsafe(chunkSize);

    while (pos < limit) {
      const want = Math.min(chunkSize, limit - pos);
      const read = fs.readSync(fd, chunk, 0, want, pos);
      if (read <= 0) break;
      pos += read;
      buf = buf.length === 0 ? Buffer.from(chunk.subarray(0, read)) : Buffer.concat([buf, chunk.subarray(0, read)]);

      let searchFrom = 0;
      let nl;
      while ((nl = buf.indexOf(NL, searchFrom)) !== -1) {
        const raw = buf.subarray(searchFrom, nl);
        lines++;
        lineStart += raw.length + 1;
        lastComplete = lineStart;
        searchFrom = nl + 1;
        if (raw.length === 0) continue;
        if (must.length && !must.some((m) => raw.includes(m))) continue;
        delivered++;
        onLine(raw.toString('utf8'), lastComplete);
      }
      buf = buf.subarray(searchFrom);
    }
    // A trailing line with no newline is deliberately NOT consumed: the writer
    // may still be appending to it. It will be picked up on the next refresh.
    return {
      offset: lastComplete,
      bytes: lastComplete - start,
      lines,
      delivered,
      truncated: limit < stat.size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** Convenience: parse every JSON line, tolerating corruption. */
export function readJsonLines(file, onObj, opt = {}) {
  let bad = 0;
  const res = readLines(
    file,
    (line, off) => {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        bad++;
        return;
      }
      onObj(o, off);
    },
    opt,
  );
  return { ...res, malformed: bad };
}

/** Append-only NDJSON writer with a buffered flush. */
export class JsonlWriter {
  constructor(file, { flushBytes = 1 << 20 } = {}) {
    this.file = file;
    this.parts = [];
    this.size = 0;
    this.flushBytes = flushBytes;
    this.written = 0;
  }
  write(obj) {
    const s = JSON.stringify(obj) + '\n';
    this.parts.push(s);
    this.size += s.length;
    this.written++;
    if (this.size >= this.flushBytes) this.flush();
  }
  flush() {
    if (!this.parts.length) return;
    fs.appendFileSync(this.file, this.parts.join(''));
    this.parts = [];
    this.size = 0;
  }
  close() {
    this.flush();
  }
}
