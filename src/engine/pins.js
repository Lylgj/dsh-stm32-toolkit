/**
 * Static pin map: scan C sources for `HAL_GPIO_Init` blocks and merge the
 * `.ioc` pin signals. This is a best-effort overview (no preprocessor), enough
 * to answer "PA5 是做什么的" in the panel.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const GPIO_PIN = /GPIO_PIN_(\d+)/g;

function parseFile(text, file) {
  const pins = [];
  let state = { pins: [], mode: '', pull: '', speed: '', alternate: '', outputType: '' };
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const pinMatch = /(\w+)\.Pin\s*=\s*([^;]+);/.exec(line);
    if (pinMatch) {
      state.pins = [...pinMatch[2].matchAll(GPIO_PIN)].map((match) => Number(match[1]));
      continue;
    }
    const mode = /(\w+)\.Mode\s*=\s*([A-Za-z0-9_GPIO]+)\s*;/.exec(line);
    if (mode && state.pins.length) { state.mode = mode[2]; continue; }
    const pull = /(\w+)\.Pull\s*=\s*([A-Za-z0-9_GPIO]+)\s*;/.exec(line);
    if (pull && state.pins.length) { state.pull = pull[2]; continue; }
    const speed = /(\w+)\.Speed\s*=\s*([A-Za-z0-9_GPIO]+)\s*;/.exec(line);
    if (speed && state.pins.length) { state.speed = speed[2]; continue; }
    const alternate = /(\w+)\.Alternate\s*=\s*([A-Za-z0-9_GPIO]+)\s*;/.exec(line);
    if (alternate && state.pins.length) { state.alternate = alternate[2]; continue; }

    const init = /HAL_GPIO_Init\s*\(\s*GPIO([A-K])\s*,/.exec(line);
    if (init && state.pins.length) {
      const port = `GPIO${init[1]}`;
      for (const pin of state.pins) {
        pins.push({
          port,
          pin,
          mode: state.mode,
          pull: state.pull,
          speed: state.speed,
          alternate: state.alternate,
          source: file,
        });
      }
      state = { pins: [], mode: '', pull: '', speed: '', alternate: '', outputType: '' };
      continue;
    }

    // Pin used without an init block in the same function: record a weak hint.
    const write = /HAL_GPIO_(?:WritePin|ReadPin|TogglePin)\s*\(\s*GPIO([A-K])\s*,\s*GPIO_PIN_(\d+)/.exec(line);
    if (write) {
      pins.push({ port: `GPIO${write[1]}`, pin: Number(write[2]), mode: 'used', pull: '', speed: '', alternate: '', source: file });
    }
  }
  return pins;
}

/** Parse `[{file,text}]` into pin records. */
export function parsePinAssignments(sources) {
  const pins = [];
  for (const source of sources) pins.push(...parseFile(source.text, source.file));
  const unique = new Map();
  for (const pin of pins) {
    const key = `${pin.port}.${pin.pin}`;
    const existing = unique.get(key);
    if (!existing || (existing.mode === 'used' && pin.mode !== 'used')) unique.set(key, pin);
  }
  return [...unique.values()].sort((a, b) => `${a.port}${a.pin}`.localeCompare(`${b.port}${b.pin}`));
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
  const pins = [...merged.values()].sort((a, b) => `${a.port}${a.pin}`.localeCompare(`${b.port}${b.pin}`));
  const ports = {};
  for (const pin of pins) {
    ports[pin.port] = ports[pin.port] ?? [];
    ports[pin.port].push(pin);
  }
  return { pins, ports, sources: sources.length };
}
