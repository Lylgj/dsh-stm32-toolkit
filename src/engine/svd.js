/**
 * CMSIS-SVD reader.
 *
 * SVD files describe every peripheral register of an MCU: address, width,
 * reset value and the bit fields inside it. That is what turns a hex dump into
 * `GPIOA.MODER.MODER5 = 0b01 (Output)`, which is the Keil "Peripherals" window
 * behaviour this plugin is reproducing.
 *
 * Supports the parts that appear in real vendor files: `derivedFrom`
 * (peripheral and register), `<dim>` arrays with `%s`, `<lsb>/<msb>` or
 * `<bitOffset>/<bitWidth>`, enumerated values and access flags.
 */

import { child, childText, children, findAll } from '../xml.js';
import { parseXml } from '../xml.js';

function num(text, fallback = 0) {
  if (text == null || text === '') return fallback;
  const value = String(text).trim();
  try {
    if (/^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value.slice(2), 16);
    if (/^#?[01]+b$/i.test(value)) {
      return Number.parseInt(value.replace(/[#b]/gi, ''), 2);
    }
    if (/^[0-9]+$/.test(value)) return Number.parseInt(value, 10);
    if (/^[0-9a-f]+$/i.test(value) && /[a-f]/i.test(value)) return Number.parseInt(value, 16);
  } catch {
    return fallback;
  }
  return fallback;
}

function parseAccess(node) {
  return childText(node, 'access') || '';
}

function parseEnumeratedValues(fieldNode) {
  const list = findAll(fieldNode, 'enumeratedValue');
  const out = [];
  for (const item of list) {
    const valueText = childText(item, 'value');
    if (!valueText) continue;
    out.push({
      name: childText(item, 'name'),
      description: childText(item, 'description'),
      value: num(valueText),
    });
  }
  return out;
}

function parseField(fieldNode) {
  const lsb = childText(fieldNode, 'lsb');
  const msb = childText(fieldNode, 'msb');
  const bitOffset = childText(fieldNode, 'bitOffset');
  const bitWidth = childText(fieldNode, 'bitWidth');
  let offset = 0;
  let width = 1;
  if (bitOffset !== '' || bitWidth !== '') {
    offset = num(bitOffset, 0);
    width = Math.max(1, num(bitWidth, 1));
  } else if (lsb !== '') {
    offset = num(lsb, 0);
    width = msb !== '' ? Math.max(1, num(msb, offset) - offset + 1) : 1;
  }
  return {
    name: childText(fieldNode, 'name'),
    description: childText(fieldNode, 'description'),
    bitOffset: offset,
    bitWidth: width,
    access: parseAccess(fieldNode),
    enumeratedValues: parseEnumeratedValues(fieldNode),
  };
}

function parseRegister(registerNode) {
  const dim = num(childText(registerNode, 'dim'), 0);
  const dimIncrement = num(childText(registerNode, 'dimIncrement'), 0);
  const base = {
    name: childText(registerNode, 'name'),
    displayName: childText(registerNode, 'displayName'),
    description: childText(registerNode, 'description'),
    addressOffset: num(childText(registerNode, 'addressOffset'), 0),
    size: num(childText(registerNode, 'size'), 32) || 32,
    access: parseAccess(registerNode),
    resetValue: num(childText(registerNode, 'resetValue'), 0),
    derivedFrom: registerNode.attrs.derivedFrom ?? '',
    fields: children(child(registerNode, 'fields'), 'field').map(parseField),
  };
  if (dim > 0 && base.fields.length === 0) {
    const registers = [];
    for (let i = 0; i < dim; i += 1) {
      const suffix = String(i);
      registers.push({
        ...base,
        name: base.name.replace('%s', suffix),
        addressOffset: base.addressOffset + i * dimIncrement,
        resetValue: base.resetValue,
        fields: [],
      });
    }
    return registers;
  }
  if (dim > 0) {
    const registers = [];
    for (let i = 0; i < dim; i += 1) {
      registers.push({
        ...base,
        name: base.name.replace('%s', String(i)),
        addressOffset: base.addressOffset + i * dimIncrement,
      });
    }
    return registers;
  }
  return [base];
}

function parsePeripheral(peripheralNode) {
  const registers = [];
  const registerContainer = child(peripheralNode, 'registers');
  for (const node of children(registerContainer, 'register')) {
    registers.push(...parseRegister(node));
  }
  // Cluster support: flatten `<cluster><register>` lists (one level deep).
  for (const cluster of children(registerContainer, 'cluster')) {
    const clusterOffset = num(childText(cluster, 'addressOffset'), 0);
    for (const node of children(cluster, 'register')) {
      for (const register of parseRegister(node)) {
        registers.push({ ...register, addressOffset: clusterOffset + register.addressOffset });
      }
    }
  }
  return {
    name: childText(peripheralNode, 'name'),
    description: childText(peripheralNode, 'description'),
    groupName: childText(peripheralNode, 'groupName'),
    baseAddress: num(childText(peripheralNode, 'baseAddress'), 0),
    derivedFrom: peripheralNode.attrs.derivedFrom ?? '',
    registers,
  };
}

/**
 * Parse SVD text into `{ name, version, description, peripherals, byName }`.
 * Derived peripherals inherit registers/baseAddress from their base, then apply
 * their own overrides.
 */
export function parseSvd(text) {
  const root = parseXml(text);
  if (!root) throw new Error('SVD 不是合法 XML');
  const device = root.name === 'device' ? root : findAll(root, 'device')[0];
  if (!device) throw new Error('SVD 里没有 <device>');
  const peripheralNodes = findAll(child(device, 'peripherals'), 'peripheral');
  const raw = peripheralNodes.map(parsePeripheral);
  const byName = new Map(raw.map((p) => [p.name, p]));

  const resolved = new Map();
  const resolving = new Set();
  const resolve = (peripheral) => {
    if (!peripheral) return null;
    if (resolved.has(peripheral.name)) return resolved.get(peripheral.name);
    if (!peripheral.derivedFrom) {
      resolved.set(peripheral.name, peripheral);
      return peripheral;
    }
    if (resolving.has(peripheral.name)) return peripheral; // cycle guard
    resolving.add(peripheral.name);
    const parent = resolve(byName.get(peripheral.derivedFrom));
    resolving.delete(peripheral.name);
    const merged = {
      ...peripheral,
      baseAddress: peripheral.baseAddress || parent?.baseAddress || 0,
      registers: peripheral.registers.length > 0 ? peripheral.registers : (parent?.registers ?? []),
    };
    resolved.set(peripheral.name, merged);
    return merged;
  };
  const peripherals = raw.map((p) => resolve(p));

  return {
    name: childText(device, 'name'),
    version: childText(device, 'version'),
    description: childText(device, 'description'),
    vendor: childText(device, 'vendor'),
    peripherals,
    byName: new Map(peripherals.map((p) => [p.name.toUpperCase(), p])),
  };
}

export function findPeripheral(svd, name) {
  if (!svd || !name) return null;
  return svd.byName.get(String(name).toUpperCase()) ?? null;
}

export function findRegister(peripheral, name) {
  if (!peripheral || !name) return null;
  const upper = String(name).toUpperCase();
  return peripheral.registers.find((r) => r.name.toUpperCase() === upper) ?? null;
}
