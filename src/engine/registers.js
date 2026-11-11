/**
 * Register reading: Cortex-M core registers over GDB, and every peripheral
 * register described by the SVD.
 *
 * Peripheral reads are batched into contiguous runs so a 60-register
 * peripheral takes a handful of memory reads instead of 60 round trips.
 */

import { hex, parseAddress } from '../util.js';

const CORE_ORDER = [
  'r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12',
  'sp', 'lr', 'pc', 'xpsr', 'msp', 'psp', 'control', 'primask', 'basepri', 'faultmask',
];

const CORE_DESCRIPTIONS = {
  r0: '通用寄存器 R0',
  r1: '通用寄存器 R1',
  r2: '通用寄存器 R2',
  r3: '通用寄存器 R3',
  r4: '通用寄存器 R4',
  r5: '通用寄存器 R5',
  r6: '通用寄存器 R6',
  r7: '通用寄存器 R7',
  r8: '通用寄存器 R8',
  r9: '通用寄存器 R9',
  r10: '通用寄存器 R10',
  r11: '通用寄存器 R11',
  r12: '通用寄存器 R12 (IP)',
  sp: '堆栈指针 (SP)',
  lr: '链接寄存器 (LR)',
  pc: '程序计数器 (PC)',
  xpsr: '程序状态寄存器 (xPSR)',
  msp: '主堆栈指针 (MSP)',
  psp: '进程堆栈指针 (PSP)',
  control: 'CONTROL 寄存器',
  primask: 'PRIMASK 中断屏蔽',
  basepri: 'BASEPRI 优先级屏蔽',
  faultmask: 'FAULTMASK 故障屏蔽',
};

function normalizeValue(text) {
  const value = String(text ?? '').trim();
  if (/^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value.slice(2), 16) >>> 0;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10) >>> 0;
  if (/^[0-9a-f]{8}$/i.test(value)) return Number.parseInt(value, 16) >>> 0;
  return null;
}

/** Decode the interesting bits of xPSR into named flags. */
export function decodeXpsr(value) {
  if (typeof value !== 'number') return [];
  const flag = (bit) => (value & (1 << bit)) !== 0;
  return [
    { name: 'N', value: flag(31) ? 1 : 0, description: '负数标志' },
    { name: 'Z', value: flag(30) ? 1 : 0, description: '零标志' },
    { name: 'C', value: flag(29) ? 1 : 0, description: '进位/借位' },
    { name: 'V', value: flag(28) ? 1 : 0, description: '溢出标志' },
    { name: 'Q', value: flag(27) ? 1 : 0, description: '饱和标志' },
    { name: 'T', value: flag(24) ? 1 : 0, description: 'Thumb 状态（应为 1）' },
    { name: 'ISR', value: value & 0x1ff, description: '当前异常号（0 = 线程模式）' },
  ];
}

export function decodeControl(value) {
  if (typeof value !== 'number') return [];
  return [
    { name: 'nPRIV', value: value & 1, description: '0=特权模式 1=用户模式' },
    { name: 'SPSEL', value: (value >> 1) & 1, description: '0=MSP 1=PSP' },
    { name: 'FPCA', value: (value >> 2) & 1, description: '浮点上下文活跃' },
  ];
}

/**
 * Read core registers.
 * @returns {Promise<{registers:Array<{name,value,hex,description,fields?}>}>}
 */
export async function readCoreRegisters(gdb) {
  const [names, values] = await Promise.all([gdb.registerNames(), gdb.registerValues()]);
  const byNumber = new Map(values.map((v) => [v.number, v.value]));
  const raw = [];
  for (const { number, name } of names) {
    if (!name) continue;
    const value = normalizeValue(byNumber.get(number));
    if (value === null) continue;
    raw.push({ name: name.toLowerCase(), value });
  }
  // Keep a deterministic, Keil-like order; unknown registers go last.
  const map = new Map(raw.map((r) => [r.name, r]));
  const ordered = [];
  for (const name of CORE_ORDER) {
    const entry = map.get(name);
    if (!entry) continue;
    ordered.push({
      name,
      value: hex(entry.value),
      raw: entry.value,
      description: CORE_DESCRIPTIONS[name] ?? '',
      fields: name === 'xpsr' ? decodeXpsr(entry.value) : name === 'control' ? decodeControl(entry.value) : [],
    });
    map.delete(name);
  }
  for (const [name, entry] of map) {
    ordered.push({ name, value: hex(entry.value), raw: entry.value, description: '', fields: [] });
  }
  return { registers: ordered };
}

function decodeField(field, registerValue) {
  const mask = field.bitWidth >= 32 ? 0xffffffff : ((1 << field.bitWidth) - 1) << field.bitOffset;
  const value = (registerValue & mask) >>> field.bitOffset;
  const enumMatch = (field.enumeratedValues ?? []).find((e) => e.value === value);
  return {
    name: field.name,
    bitOffset: field.bitOffset,
    bitWidth: field.bitWidth,
    value,
    hex: `0x${value.toString(16).toUpperCase()}`,
    meaning: enumMatch ? (enumMatch.name || enumMatch.description) : '',
    description: field.description ?? '',
    access: field.access ?? '',
  };
}

/** Build byte ranges for batched reads. */
function buildRanges(registers) {
  const sorted = [...registers].sort((a, b) => a.addressOffset - b.addressOffset);
  const ranges = [];
  let current = null;
  for (const register of sorted) {
    const sizeBytes = Math.max(1, Math.ceil((register.size || 32) / 8));
    const start = register.addressOffset;
    const end = start + sizeBytes;
    if (!current || start < current.start || start - current.end > 64 || end - current.start > 256) {
      current = { start, end, registers: [] };
      ranges.push(current);
    }
    current.end = Math.max(current.end, end);
    current.registers.push(register);
  }
  return ranges;
}

/**
 * Read every register of one peripheral, batched.
 *
 * @param {object} gdb GdbSession
 * @param {object} peripheral SVD peripheral object
 * @param {{maxRegisters?:number}} [options]
 */
export async function readPeripheral(gdb, peripheral, options = {}) {
  if (!peripheral) throw new Error('外设不存在');
  const max = options.maxRegisters ?? 256;
  const registers = peripheral.registers.slice(0, max);
  const ranges = buildRanges(registers);
  const memory = new Map(); // offset -> byte
  for (const range of ranges) {
    const address = hex(peripheral.baseAddress + range.start);
    const count = range.end - range.start;
    const result = await gdb.readMemory(address, count);
    const bytes = Buffer.from(result.contents, 'hex');
    for (let i = 0; i < bytes.length; i += 1) memory.set(range.start + i, bytes[i]);
  }
  const decoded = registers.map((register) => {
    const sizeBytes = Math.max(1, Math.ceil((register.size || 32) / 8));
    const bytes = Buffer.alloc(sizeBytes);
    for (let i = 0; i < sizeBytes; i += 1) bytes[i] = memory.get(register.addressOffset + i) ?? 0;
    let value = 0;
    for (let i = sizeBytes - 1; i >= 0; i -= 1) value = ((value << 8) | bytes[i]) >>> 0;
    return {
      name: register.name,
      address: hex(peripheral.baseAddress + register.addressOffset),
      addressOffset: register.addressOffset,
      size: register.size,
      access: register.access,
      resetValue: hex(register.resetValue),
      value: hex(value),
      raw: value,
      description: register.description,
      fields: register.fields.map((f) => decodeField(f, value)),
    };
  });
  return {
    peripheral: peripheral.name,
    baseAddress: hex(peripheral.baseAddress),
    registers: decoded,
  };
}

/** Like readPeripheral but for one register (used by the watch feature). */
export async function readSingleRegister(gdb, peripheral, registerName) {
  const register = peripheral.registers.find(
    (r) => r.name.toUpperCase() === String(registerName).toUpperCase(),
  );
  if (!register) throw new Error(`${peripheral.name} 没有寄存器 ${registerName}`);
  const sizeBytes = Math.max(1, Math.ceil((register.size || 32) / 8));
  const address = peripheral.baseAddress + register.addressOffset;
  const result = await gdb.readMemory(hex(address), sizeBytes);
  const bytes = Buffer.from(result.contents, 'hex');
  let value = 0;
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = ((value << 8) | bytes[i]) >>> 0;
  return {
    name: register.name,
    address: hex(address),
    value: hex(value),
    raw: value,
    fields: register.fields.map((f) => decodeField(f, value)),
  };
}

/** Resolve `GPIOA.MODER` or `0x40020000`-style input into an address. */
export function resolveRegisterAddress(svd, input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (/^GPIO/i.test(text) || text.includes('.')) {
    const [peripheralName, registerName] = text.split('.');
    const peripheral = svd?.byName?.get(peripheralName.toUpperCase());
    if (!peripheral) return null;
    if (!registerName) return { peripheral, register: null, address: peripheral.baseAddress };
    const register = peripheral.registers.find(
      (r) => r.name.toUpperCase() === registerName.toUpperCase(),
    );
    if (!register) return null;
    return {
      peripheral,
      register,
      address: peripheral.baseAddress + register.addressOffset,
    };
  }
  const address = parseAddress(text);
  if (address === null) return null;
  // Find the peripheral that owns this address, for a friendlier decode.
  const owner = svd?.peripherals?.find((p) => {
    const last = p.registers.length > 0
      ? Math.max(...p.registers.map((r) => r.addressOffset + 4))
      : 0x400;
    return address >= p.baseAddress && address < p.baseAddress + Math.max(last, 0x400);
  });
  return { peripheral: owner ?? null, register: null, address };
}
