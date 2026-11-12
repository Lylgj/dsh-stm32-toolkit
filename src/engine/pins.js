/**
 * Static pin map: scan C sources for `HAL_GPIO_Init` blocks and merge the
 * `.ioc` pin signals. This is a best-effort overview (no preprocessor), enough
 * to answer "PA5 是做什么的" in the panel.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const GPIO_PIN = /GPIO_PIN_(\d+)/g;
const LITERAL_PORT = /^GPIO([A-K])$/;
const LITERAL_PIN = /^GPIO_PIN_\d+$/;

/** Collect `#define NAME value` pairs so macro-based pin names resolve. */
function collectDefines(sources) {
  const defines = new Map();
  for (const source of sources) {
    const text = String(source.text).replace(/\\\r?\n/g, ' ');
    const re = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]+(.+?)[ \t]*$/gm;
    let match;
    while ((match = re.exec(text))) {
      const name = match[1];
      if (LITERAL_PIN.test(name) || LITERAL_PORT.test(name)) continue;
      let value = match[2].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '').trim();
      if (!value || /^[+-]?\d+$/.test(value) === false && !/GPIO|_PIN|\(/.test(value) && !/^[A-Za-z_]\w*$/.test(value)) continue;
      defines.set(name, value);
    }
  }
  return defines;
}

/** Expand macros until only literals remain (bounded). */
function expandMacros(expr, defines, depth = 0) {
  if (depth > 6) return expr;
  let out = String(expr);
  out = out.replace(/\b[A-Za-z_]\w*\b/g, (name) => {
    if (LITERAL_PIN.test(name) || LITERAL_PORT.test(name)) return name;
    const value = defines.get(name);
    return value === undefined ? name : value;
  });
  return out === expr ? out : expandMacros(out, defines, depth + 1);
}

function pinsIn(expr) {
  return [...new Set([...String(expr).matchAll(GPIO_PIN)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

function portIn(expr) {
  const match = /GPIO([A-K])\b/.exec(String(expr)) ?? LITERAL_PORT.exec(String(expr).trim());
  return match ? `GPIO${match[1]}` : '';
}

/** A readable label for a pin expression: the macro name if there is one. */
function labelFor(expr) {
  const trimmed = String(expr).trim();
  const single = /^([A-Za-z_]\w*)$/.exec(trimmed);
  if (!single || LITERAL_PIN.test(single[1])) return '';
  return single[1].replace(/_?(PIN|GPIO|PORT)$/i, '');
}

function blankState() {
  return { pins: [], mode: '', pull: '', speed: '', alternate: '', outputType: '', label: '' };
}

function parseFile(text, file, defines) {
  const pins = [];
  let state = blankState();
  const lines = String(text).split(/\r?\n/);
  for (const rawLine of lines) {
    // Several `s.FIELD = ...;` statements may share one line.
    for (const part of rawLine.split(/;/)) {
      const line = part.trim();
      if (!line) continue;

      const pinMatch = /(\w+)\.Pin\s*=\s*(.+)$/.exec(line);
      if (pinMatch) {
        const expr = expandMacros(pinMatch[2], defines);
        state.pins = pinsIn(expr);
        state.label = labelFor(pinMatch[2]) || labelFor(expr);
        continue;
      }
      const mode = /(\w+)\.Mode\s*=\s*(.+)$/.exec(line);
      if (mode && state.pins.length) { state.mode = expandMacros(mode[2], defines).trim(); continue; }
      const pull = /(\w+)\.Pull\s*=\s*(.+)$/.exec(line);
      if (pull && state.pins.length) { state.pull = expandMacros(pull[2], defines).trim(); continue; }
      const speed = /(\w+)\.Speed\s*=\s*(.+)$/.exec(line);
      if (speed && state.pins.length) { state.speed = expandMacros(speed[2], defines).trim(); continue; }
      const alternate = /(\w+)\.Alternate\s*=\s*(.+)$/.exec(line);
      if (alternate && state.pins.length) { state.alternate = expandMacros(alternate[2], defines).trim(); continue; }
      const outputType = /(\w+)\.OutputType\s*=\s*(.+)$/.exec(line);
      if (outputType && state.pins.length) { state.outputType = expandMacros(outputType[2], defines).trim(); continue; }

      const init = /HAL_GPIO_Init\s*\(\s*([^,]+),/.exec(line);
      if (init && state.pins.length) {
        const port = portIn(expandMacros(init[1], defines));
        if (port) {
          for (const pin of state.pins) {
            pins.push({
              port,
              pin,
              mode: state.mode,
              pull: state.pull,
              speed: state.speed,
              alternate: state.alternate,
              outputType: state.outputType,
              label: state.label,
              source: file,
            });
          }
        }
        state = blankState();
        continue;
      }

      // Pin used without an init block in the same function: record a weak hint.
      const write = /HAL_GPIO_(?:WritePin|ReadPin|TogglePin)\s*\(\s*([^,]+),\s*([^,)]+)/.exec(line);
      if (write) {
        const port = portIn(expandMacros(write[1], defines));
        const expr = expandMacros(write[2], defines);
        for (const pin of pinsIn(expr)) {
          pins.push({
            port,
            pin,
            mode: 'used',
            pull: '',
            speed: '',
            alternate: '',
            outputType: '',
            label: labelFor(write[2]) || labelFor(expr),
            source: file,
          });
        }
      }
    }
  }
  return pins;
}

/** Pins from static `{ GPIOx, GPIO_PIN_n }` tables (drivers keep them in arrays). */
function collectArrayPins(sources, defines) {
  const pins = [];
  for (const source of sources) {
    const text = String(source.text);
    if (!/HAL_GPIO_Init/.test(text)) continue;
    // A driver file with a single GPIO_Init struct shape can lend its mode to
    // the table entries it initializes in a loop.
    const modes = [...new Set([...text.matchAll(/\.Mode\s*=\s*([^;]+);/g)]
      .map((match) => expandMacros(match[1], defines).trim())
      .filter(Boolean))];
    const pulls = [...new Set([...text.matchAll(/\.Pull\s*=\s*([^;]+);/g)]
      .map((match) => expandMacros(match[1], defines).trim())
      .filter(Boolean))];
    const speeds = [...new Set([...text.matchAll(/\.Speed\s*=\s*([^;]+);/g)]
      .map((match) => expandMacros(match[1], defines).trim())
      .filter(Boolean))];
    const mode = modes.length === 1 ? modes[0] : 'used';
    const re = /\{\s*(GPIO[A-K]|[A-Za-z_]\w*)\s*,\s*([^{}]{1,80})\}/g;
    let match;
    while ((match = re.exec(text))) {
      const port = portIn(expandMacros(match[1], defines));
      const numbers = pinsIn(expandMacros(match[2], defines));
      if (!port || !numbers.length) continue;
      for (const pin of numbers) {
        pins.push({
          port,
          pin,
          mode,
          pull: pulls.length === 1 ? pulls[0] : '',
          speed: speeds.length === 1 ? speeds[0] : '',
          alternate: '',
          outputType: '',
          label: '',
          source: source.file,
        });
      }
    }
  }
  return pins;
}

/** Sort by port, then by pin *number* (PA9 before PA10). */
function comparePins(a, b) {
  if (a.port !== b.port) return a.port < b.port ? -1 : 1;
  return Number(a.pin) - Number(b.pin);
}

/** Parse `[{file,text}]` into pin records. */
export function parsePinAssignments(sources) {
  const defines = collectDefines(sources);
  const pins = [];
  for (const source of sources) pins.push(...parseFile(source.text, source.file, defines));
  for (const source of sources) pins.push(...collectArrayPins([source], defines));
  const unique = new Map();
  for (const pin of pins) {
    if (!pin.port) continue;
    const key = `${pin.port}.${pin.pin}`;
    const existing = unique.get(key);
    if (!existing || (existing.mode === 'used' && pin.mode !== 'used')) unique.set(key, pin);
  }
  return [...unique.values()].sort(comparePins);
}

/** Pins declared by a parsed `.ioc`. */
export function pinsFromIoc(parsed) {
  const pins = [];
  for (const item of parsed?.pins ?? []) {
    const match = /^P([A-K])(\d+)$/.exec(String(item.pin ?? '').toUpperCase());
    if (!match) continue;
    pins.push({
      port: `GPIO${match[1]}`,
      pin: Number(match[2]),
      mode: item.signal || '',
      label: item.label || '',
      source: parsed.file || '',
    });
  }
  return pins;
}

/** Walk a directory tree and collect .c/.h sources (bounded). */
export function collectSources(dir, { maxFiles = 400, maxBytes = 512 * 1024 } = {}) {
  const sources = [];
  const walk = (root, level) => {
    if (level > 4 || sources.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (sources.length >= maxFiles) return;
      const full = join(root, entry.name);
      if (entry.isDirectory()) {
        if (/^(\.git|node_modules|objects|build|build-.*|debug|release|drivers|cmsis)$/i.test(entry.name)) continue;
        walk(full, level + 1);
      } else if (/\.(c|h)$/i.test(entry.name)) {
        try {
          if (statSync(full).size > maxBytes) continue;
          sources.push({ file: full, text: readFileSync(full, 'utf8') });
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(dir, 0);
  return sources;
}

/** Merge source-derived pins with `.ioc` pins (ioc wins on mode/label). */
export function buildPinMap(dir, ioc, sources = collectSources(dir)) {
  const fromSource = parsePinAssignments(sources);
  const fromIoc = pinsFromIoc(ioc);
  const merged = new Map();
  for (const pin of fromSource) merged.set(`${pin.port}.${pin.pin}`, pin);
  for (const pin of fromIoc) {
    const key = `${pin.port}.${pin.pin}`;
    const existing = merged.get(key) ?? { port: pin.port, pin: pin.pin, mode: '', pull: '', speed: '', alternate: '', source: '' };
    merged.set(key, { ...existing, label: pin.label || existing.label || '', mode: pin.mode || existing.mode });
  }
  const pins = [...merged.values()].sort(comparePins);
  const ports = {};
  for (const pin of pins) {
    ports[pin.port] = ports[pin.port] ?? [];
    ports[pin.port].push(pin);
  }
  return { pins, ports, sources: sources.length };
}
