/**
 * Symbol tables: Keil/armlink `.map`, GNU ld `.map`, `nm` output and a small
 * built-in ELF symbol reader (so the feature works without a toolchain).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { run } from '../util.js';

const SECTION_TYPES = new Set(['Code', 'Data', 'Zero', 'RO', 'RW', 'ZI', 'Thumb Code', 'ARM Code']);

/** Parse an armlink map (Keil MDK). */
export function parseKeilMap(text) {
  const lines = String(text).split(/\r?\n/);
  const symbols = [];
  const sections = [];
  let inSymbols = false;
  let inSections = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^Image Symbol Table/i.test(trimmed)) {
      inSymbols = true;
      inSections = false;
      continue;
    }
    if (/^Memory Map of the image/i.test(trimmed)) {
      inSections = true;
      inSymbols = false;
      continue;
    }
    if (/^Image component sizes/i.test(trimmed)) {
      inSymbols = false;
      inSections = false;
    }
    if (inSymbols) {
      // main   0x08000c4d   Thumb Code   132  main.o(.text.main)
      const match = /^\s*(\S+)\s+(0x[0-9a-fA-F]+)\s+([A-Za-z ]+?)\s+(\d+)\s+(.*)$/.exec(line);
      if (match) {
        const type = match[3].trim();
        if (!SECTION_TYPES.has(type) && type !== 'Number' && type !== 'Section') continue;
        const object = match[5].trim();
        symbols.push({
          name: match[1],
          address: parseInt(match[2], 16),
          type,
          size: Number(match[4]),
          object,
          section: /\(([^)]+)\)/.exec(object)?.[1] ?? '',
        });
      }
    }
    if (inSections) {
      // 0x08000000   0x00000123   Code   RO   1234    main.o(.text.main)
      const match = /^\s*(0x[0-9a-fA-F]+)\s+(0x[0-9a-fA-F]+)\s+(Code|Data|Zero|RO|RW|ZI)\s+(?:RO|RW|ZI)\s+(\d+)\s+(.*)$/.exec(line);
      if (match) {
        sections.push({
          address: parseInt(match[1], 16),
          size: parseInt(match[2], 16),
          type: match[3],
          object: match[5].trim(),
        });
      }
    }
  }
  return { symbols, sections, source: 'keil-map' };
}

/** Parse a GNU ld map file (section + symbol lines). */
export function parseGnuMap(text) {
  const symbols = [];
  const sections = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const section = /^\s*\.(\S+)\s+(0x[0-9a-fA-F]+)\s+(0x[0-9a-fA-F]+)/.exec(line);
    if (section) {
      sections.push({ name: section[1], address: parseInt(section[2], 16), size: parseInt(section[3], 16) });
      continue;
    }
    const symbol = /^\s+(0x[0-9a-fA-F]+)\s+(\S+)$/.exec(line);
    if (symbol) {
      symbols.push({
        name: symbol[2],
        address: parseInt(symbol[1], 16),
        type: 'unknown',
        size: 0,
        object: '',
        section: '',
      });
    }
  }
  return { symbols, sections, source: 'gnu-map' };
}

/** Parse `nm -S` (or plain `nm`) output. */
export function parseNmOutput(text) {
  const symbols = [];
  for (const line of String(text).split(/\r?\n/)) {
    const withSize = /^\s*([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([A-Za-z?])\s+(\S+)\s*$/.exec(line);
    if (withSize) {
      symbols.push({
        name: withSize[4],
        address: parseInt(withSize[1], 16),
        size: parseInt(withSize[2], 16),
        type: withSize[3],
        object: '',
        section: '',
      });
      continue;
    }
    const plain = /^\s*([0-9a-fA-F]+)?\s*([A-Za-z?])\s+(\S+)\s*$/.exec(line);
    if (plain && plain[3] && plain[2] !== 'type') {
      symbols.push({
        name: plain[3],
        address: plain[1] ? parseInt(plain[1], 16) : 0,
        size: 0,
        type: plain[2],
        object: '',
        section: '',
      });
    }
  }
  return { symbols, sections: [], source: 'nm' };
}

// ---------------------------------------------------------------- ELF

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/**
 * Minimal ELF32/ELF64 little-endian symbol table reader.
 * Returns null when the file is not an ELF we understand.
 */
export function readElfSymbols(file) {
  const data = readFileSync(file);
  if (data.length < 52 || !data.subarray(0, 4).equals(ELF_MAGIC)) return null;
  const is64 = data[4] === 2;
  const le = data[5] === 1;
  if (!le) return null;
  const end = (bytes, offset) => {
    if (bytes === 2) return data.readUInt16LE(offset);
    if (bytes === 4) return data.readUInt32LE(offset);
    return is64 ? Number(data.readBigUInt64LE(offset)) : data.readUInt32LE(offset);
  };
  const machine = end(2, 0x12 + (is64 ? 0 : 0));
  const shoff = end(is64 ? 8 : 4, is64 ? 0x28 : 0x20);
  const shentsize = end(2, is64 ? 0x3a : 0x2e);
  const shnum = end(2, is64 ? 0x3c : 0x30);
  if (!shoff || !shentsize || !shnum || shoff >= data.length) return null;

  const sections = [];
  for (let i = 0; i < shnum; i += 1) {
    const base = shoff + i * shentsize;
    if (base + shentsize > data.length) break;
    sections.push({
      nameOffset: end(4, base),
      type: end(4, base + 4),
      offset: end(is64 ? 8 : 4, base + (is64 ? 0x18 : 0x10)),
      size: end(is64 ? 8 : 4, base + (is64 ? 0x20 : 0x14)),
      link: end(4, base + (is64 ? 0x28 : 0x18)),
      entsize: end(is64 ? 8 : 4, base + (is64 ? 0x38 : 0x24)),
    });
  }
  const strtabSection = sections.find((section) => section.type === 3); // SHT_STRTAB
  const symtab = sections.find((section) => section.type === 2); // SHT_SYMTAB
  if (!symtab || !strtabSection) return null;
  const strtab = data.subarray(strtabSection.offset, strtabSection.offset + strtabSection.size);
  const symbols = [];
  const entrySize = symtab.entsize || (is64 ? 24 : 16);
  const count = Math.floor(symtab.size / entrySize);
  for (let i = 0; i < count; i += 1) {
    const base = symtab.offset + i * entrySize;
    if (base + entrySize > data.length) break;
    const nameOffset = data.readUInt32LE(base);
    const value = is64 ? Number(data.readBigUInt64LE(base + 8)) : data.readUInt32LE(base + 4);
    const size = is64 ? Number(data.readBigUInt64LE(base + 16)) : data.readUInt32LE(base + 8);
    const info = data[base + (is64 ? 4 : 12)];
    const type = info & 0x0f;
    if (!nameOffset || nameOffset >= strtab.length) continue;
    const endName = strtab.indexOf(0, nameOffset);
    const name = strtab.subarray(nameOffset, endName === -1 ? strtab.length : endName).toString('utf8');
    if (!name) continue;
    symbols.push({
      name,
      address: value,
      size,
      type: type === 2 ? 'FUNC' : type === 1 ? 'OBJECT' : 'OTHER',
      bind: info >> 4,
      machine,
      object: '',
      section: '',
    });
  }
  return { symbols, sections: sections.map((section) => ({ offset: section.offset, size: section.size, type: section.type })), source: 'elf' };
}

// ---------------------------------------------------------------- lookup

export function sortedSymbols(symbols) {
  return [...symbols].sort((a, b) => a.address - b.address);
}

/** Nearest symbol at or below `address` (with an optional max distance). */
export function lookupAddress(symbols, address, maxDistance = 0x10000) {
  const list = sortedSymbols(symbols).filter((symbol) => symbol.address <= address);
  if (!list.length) return null;
  const symbol = list[list.length - 1];
  const delta = address - symbol.address;
  if (symbol.size > 0 && delta >= symbol.size) return null;
  if (maxDistance > 0 && delta > maxDistance) return null;
  return { ...symbol, offset: delta };
}

/** Find symbols by exact name or substring. */
export function findSymbols(symbols, query, limit = 50) {
  const text = String(query ?? '').trim();
  if (!text) return [];
  const exact = symbols.filter((symbol) => symbol.name === text);
  if (exact.length) return exact;
  const lowered = text.toLowerCase();
  return symbols.filter((symbol) => symbol.name.toLowerCase().includes(lowered)).slice(0, limit);
}

/** Locate and parse a symbol source for a project directory. */
export async function loadSymbols(dir, options = {}) {
  const candidates = [];
  const walk = (root, depth) => {
    if (depth > 3) return;
    const entries = readdirSafe(root);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (/^(\.git|node_modules|objects|build)$/i.test(entry.name)) continue;
        walk(join(root, entry.name), depth + 1);
      } else if (/\.map$/i.test(entry.name)) {
        candidates.push(join(root, entry.name));
      } else if (/\.(elf|axf)$/i.test(entry.name)) {
        candidates.push(join(root, entry.name));
      }
    }
  };
  if (dir) walk(dir, 0);
  // Prefer a .map (fast) over an ELF.
  const weight = (file) => (extname(file).toLowerCase() === '.map' ? 0 : 1);
  candidates.sort((a, b) => weight(a) - weight(b));
  for (const file of candidates) {
    try {
      if (extname(file).toLowerCase() === '.map') {
        const text = readFileSync(file, 'utf8');
        const parsed = /image symbol table/i.test(text) ? parseKeilMap(text) : parseGnuMap(text);
        if (parsed.symbols.length) return { ...parsed, file, mtime: statSync(file).mtimeMs };
      } else {
        const parsed = readElfSymbols(file);
        if (parsed?.symbols?.length) return { ...parsed, file, mtime: statSync(file).mtimeMs };
      }
    } catch {
      /* try next */
    }
  }
  const nm = options.nm || 'arm-none-eabi-nm';
  for (const file of candidates) {
    if (!/\.(elf|axf)$/i.test(file)) continue;
    const result = await run(nm, ['-S', file], { timeoutMs: 30_000 });
    if (result.ok && result.stdout.trim()) {
      return { ...parseNmOutput(result.stdout), file, mtime: statSync(file).mtimeMs };
    }
  }
  return null;
}

/** Parse one explicit file (map / elf / axf) into a symbol table. */
export function loadSymbolFile(file) {
  if (!file || !fileExistsSafe(file)) return null;
  const ext = extname(file).toLowerCase();
  if (ext === '.map') {
    const text = readFileSync(file, 'utf8');
    const parsed = /image symbol table/i.test(text) ? parseKeilMap(text) : parseGnuMap(text);
    return { ...parsed, file, mtime: statSync(file).mtimeMs };
  }
  const parsed = readElfSymbols(file);
  return parsed ? { ...parsed, file, mtime: statSync(file).mtimeMs } : null;
}

function fileExistsSafe(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
