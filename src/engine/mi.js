/**
 * GDB/MI output parser.
 *
 * GDB speaks line-oriented MI: `~"console text"`, `^done,frame={...}`,
 * `*stopped,reason="breakpoint-hit"...`, `=thread-created,...`, `(gdb)`.
 * This module turns those lines into plain JS objects; it does not launch
 * anything.
 *
 * Grammar reference: https://sourceware.org/gdb/current/onlinedocs/gdb/GDB_002fMI-Output-Syntax.html
 */

/** Decode a C-string body (MI uses C escapes, including octal). */
export function unescapeCString(body) {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    if (next === 'n') { out += '\n'; i += 1; continue; }
    if (next === 't') { out += '\t'; i += 1; continue; }
    if (next === 'r') { out += '\r'; i += 1; continue; }
    if (next === 'a') { out += '\x07'; i += 1; continue; }
    if (next === 'b') { out += '\b'; i += 1; continue; }
    if (next === 'f') { out += '\f'; i += 1; continue; }
    if (next === 'v') { out += '\v'; i += 1; continue; }
    if (next === '"' || next === '\\' || next === "'") { out += next; i += 1; continue; }
    if (/[0-7]/.test(next)) {
      let oct = '';
      let j = i + 1;
      while (j < body.length && oct.length < 3 && /[0-7]/.test(body[j])) {
        oct += body[j];
        j += 1;
      }
      out += String.fromCharCode(Number.parseInt(oct, 8));
      i = j - 1;
      continue;
    }
    out += next;
    i += 1;
  }
  return out;
}

function skipSpace(text, pos) {
  let i = pos;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

function parseCString(text, pos) {
  // text[pos] === '"'
  let i = pos + 1;
  let body = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      body += ch;
      if (i + 1 < text.length) body += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') break;
    body += ch;
    i += 1;
  }
  return { value: unescapeCString(body), pos: i + 1 };
}

/**
 * Parse one MI value starting at `pos`.
 * @returns {{value:any,pos:number}}
 */
export function parseMiValue(text, pos = 0) {
  let i = skipSpace(text, pos);
  const ch = text[i];
  if (ch === '"') {
    return parseCString(text, i);
  }
  if (ch === '{') {
    const obj = {};
    i += 1;
    for (;;) {
      i = skipSpace(text, i);
      if (i >= text.length) break;
      if (text[i] === '}') { i += 1; break; }
      const colon = text.indexOf('=', i);
      if (colon === -1) break;
      const key = text.slice(i, colon).trim();
      const parsed = parseMiValue(text, colon + 1);
      obj[key] = parsed.value;
      i = parsed.pos;
      i = skipSpace(text, i);
      if (text[i] === ',') i += 1;
    }
    return { value: obj, pos: i };
  }
  if (ch === '[') {
    const arr = [];
    i += 1;
    for (;;) {
      i = skipSpace(text, i);
      if (i >= text.length) break;
      if (text[i] === ']') { i += 1; break; }
      // List members may be plain values or `name=value` pairs.
      const start = i;
      const parsed = parseMiValue(text, i);
      if (text[parsed.pos] === '=') {
        const pairValue = parseMiValue(text, parsed.pos + 1);
        arr.push({ [parsed.value]: pairValue.value });
        i = pairValue.pos;
      } else {
        arr.push(parsed.value);
        i = parsed.pos;
      }
      i = skipSpace(text, i);
      if (text[i] === ',') i += 1;
      if (i === start) i += 1; // never spin on an unexpected terminator
    }
    return { value: arr, pos: i };
  }
  // Bare const: number, identifier, or `void`.
  let j = i;
  while (j < text.length && !/[,}\]=]/.test(text[j])) j += 1;
  const raw = text.slice(i, j).trim();
  return { value: raw, pos: j };
}

/** Parse the payload of a `^done,...`/`*stopped,...` line into an object. */
export function parseMiPayload(payload) {
  const text = String(payload ?? '').trim();
  if (!text) return { class: '', data: {} };
  const comma = text.indexOf(',');
  const cls = comma === -1 ? text : text.slice(0, comma);
  const rest = comma === -1 ? '' : text.slice(comma + 1);
  const data = {};
  if (!rest) return { class: cls, data };
  let i = 0;
  while (i < rest.length) {
    i = skipSpace(rest, i);
    if (i >= rest.length) break;
    const eq = rest.indexOf('=', i);
    if (eq === -1) break;
    const key = rest.slice(i, eq).trim();
    const parsed = parseMiValue(rest, eq + 1);
    data[key] = parsed.value;
    i = parsed.pos;
    if (rest[i] === ',') i += 1;
  }
  return { class: cls, data };
}

/**
 * Stateful line parser. Feed it stdout chunks; it returns complete records.
 *
 * Record shape:
 *  { kind: 'result'|'exec'|'status'|'notify'|'console'|'target'|'log'|'prompt',
 *    token?: string, class?: string, data?: object, text?: string }
 */
export class MiParser {
  constructor() {
    this.buffer = '';
  }

  feed(chunk) {
    this.buffer += String(chunk ?? '');
    const records = [];
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) records.push(...this.parseLine(line));
    }
    // GDB's prompt is written without a trailing newline.
    if (this.buffer.trim() === '(gdb)') {
      records.push({ kind: 'prompt' });
      this.buffer = '';
    }
    return records;
  }

  parseLine(line) {
    const record = this.parseSingleLine(line);
    if (!record) return [];
    return [record];
  }

  parseSingleLine(line) {
    const trimmed = line.trimEnd();
    if (trimmed === '(gdb)') return { kind: 'prompt' };
    const m = /^(\d*)([\^+*=~@&])([\s\S]*)$/.exec(trimmed);
    if (!m) return { kind: 'console', text: `${line}\n` };
    const [, token, marker, rest] = m;
    if (marker === '~' || marker === '@' || marker === '&') {
      const body = rest.startsWith('"') ? parseCString(rest, 0).value : rest;
      const kind = marker === '~' ? 'console' : marker === '@' ? 'target' : 'log';
      return { kind, token, text: body };
    }
    const { class: cls, data } = parseMiPayload(rest);
    if (marker === '^') return { kind: 'result', token, class: cls, data, raw: rest };
    if (marker === '*') return { kind: 'exec', token, class: cls, data, raw: rest };
    if (marker === '+') return { kind: 'status', token, class: cls, data, raw: rest };
    return { kind: 'notify', token, class: cls, data, raw: rest };
  }
}

/** Turn a `*stopped` payload into a small, UI-friendly object. */
export function summarizeStop(data = {}) {
  const frame = data.frame ?? {};
  return {
    reason: data.reason ?? '',
    breakpointId: data.bkptno ?? '',
    threadId: data['thread-id'] ?? '',
    stoppedThreads: data['stopped-threads'] ?? '',
    func: frame.func ?? '',
    file: frame.file ?? frame.fullname ?? '',
    line: frame.line ? Number(frame.line) : 0,
    addr: frame.addr ?? '',
    raw: data,
  };
}

/** Read `.number`-style ids GDB returns as strings. */
export function miInt(value, fallback = 0) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}
