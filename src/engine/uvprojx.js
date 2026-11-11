/**
 * Keil MDK `.uvprojx` reader.
 *
 * The file is XML; this module turns one target into the facts the rest of the
 * toolkit needs: device, memory map, compiler settings, source list, output
 * artifact and the debugger/probe the project was configured with. Nothing is
 * executed here — building is `build.js`' job.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { child, childText, children, findAll, findPath, parseXml } from '../xml.js';

/** Split a Keil path/define list on `;`, `,` or whitespace, keeping quotes intact. */
export function splitList(text) {
  if (!text) return [];
  return String(text)
    .split(/[;,\r\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Parse the `Cpu` line, e.g. `IROM(0x08000000,0x100000) IRAM(0x20000000,0x20000) CPUTYPE("Cortex-M4") FPU2 CLOCK(12000000) ELITTLE`. */
export function parseCpuLine(cpu) {
  const text = String(cpu ?? '');
  const regions = [];
  const re = /([A-Za-z0-9_]+)\s*\(\s*0x([0-9a-fA-F]+)\s*,\s*0x([0-9a-fA-F]+)\s*\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].toUpperCase();
    if (!/^(I?ROM|I?RAM|OCR_RVCT\d+)/.test(name)) continue;
    regions.push({
      name,
      kind: name.includes('ROM') ? 'rom' : 'ram',
      start: Number.parseInt(m[2], 16) >>> 0,
      size: Number.parseInt(m[3], 16) >>> 0,
    });
  }
  const core = /CPUTYPE\("?([^)"\s]+)"?\)/.exec(text)?.[1] ?? '';
  const fpu = /FPU(\d)/.exec(text)?.[1] ?? '';
  const clock = /CLOCK\((\d+)\)/.exec(text)?.[1] ?? '';
  const endian = /EBIG/.test(text) ? 'big' : /ELITTLE/.test(text) ? 'little' : '';
  return {
    raw: text,
    core,
    fpu: fpu === '' ? '' : Number(fpu),
    clock: clock === '' ? '' : Number(clock),
    endian,
    rom: regions.filter((r) => r.kind === 'rom'),
    ram: regions.filter((r) => r.kind === 'ram'),
    regions,
  };
}

/** Map an STM32 device name to the OpenOCD target config basename. */
export function openocdTargetForDevice(device) {
  const name = String(device ?? '').toUpperCase();
  const table = [
    ['STM32F0', 'stm32f0x'],
    ['STM32F1', 'stm32f1x'],
    ['STM32F2', 'stm32f2x'],
    ['STM32F3', 'stm32f3x'],
    ['STM32F4', 'stm32f4x'],
    ['STM32F7', 'stm32f7x'],
    ['STM32L0', 'stm32l0'],
    ['STM32L1', 'stm32l1'],
    ['STM32L4', 'stm32l4x'],
    ['STM32L5', 'stm32l5x'],
    ['STM32G0', 'stm32g0x'],
    ['STM32G4', 'stm32g4x'],
    ['STM32H7', 'stm32h7x'],
    ['STM32WB', 'stm32wbx'],
    ['STM32WL', 'stm32wlx'],
    ['STM32U5', 'stm32u5x'],
    ['STM32C0', 'stm32c0x'],
  ];
  for (const [prefix, target] of table) {
    if (name.startsWith(prefix)) return `target/${target}.cfg`;
  }
  return '';
}

/** Pick an OpenOCD interface config from the Keil debugger string (fallback: ST-Link). */
export function openocdInterfaceForDebugger(debuggerInfo = {}) {
  const text = `${debuggerInfo.pMon ?? ''} ${(debuggerInfo.dlls ?? []).join(' ')}`.toLowerCase();
  if (text.includes('cmsis') || text.includes('dap')) return 'interface/cmsis-dap.cfg';
  if (text.includes('jlink') || text.includes('j-link')) return 'interface/jlink.cfg';
  if (text.includes('stlink') || text.includes('st-link') || text.includes('stlinkiii')) return 'interface/stlink.cfg';
  return 'interface/stlink.cfg';
}

function parseDebugOption(targetNode) {
  const opt = findPath(targetNode, ['TargetOption', 'TargetCommonOption', 'DebugOpt'])
    ?? findAll(targetNode, 'DebugOpt')[0]
    ?? null;
  const pMon = childText(opt, 'pMon');
  const dlls = findAll(opt, 'pMon').map((n) => n.text.trim()).filter(Boolean);
  return {
    simulator: childText(opt, 'uSim') === '1',
    pMon,
    dlls: [...new Set([pMon, ...dlls].filter(Boolean))],
  };
}

function inputTypeLabel(fileType, ext) {
  const type = String(fileType ?? '').trim();
  if (type === '1') return 'c';
  if (type === '2') return 'asm';
  if (type === '3') return 'h';
  if (type === '4') return 'lib';
  if (type === '5') return 'txt';
  const lower = String(ext ?? '').toLowerCase();
  if (lower === '.c') return 'c';
  if (lower === '.s' || lower === '.asm') return 'asm';
  if (lower === '.cpp' || lower === '.cc') return 'cpp';
  return 'other';
}

/**
 * Read a `.uvprojx` file.
 * @param {string} file absolute path
 * @param {string} [targetName] optional target; defaults to the first Target
 */
export function readUvprojx(file, targetName) {
  const text = readFileSync(file, 'utf8');
  const root = parseXml(text);
  if (!root) throw new Error(`无法解析 XML: ${file}`);
  const projectDir = dirname(file);
  const targets = findAll(root, 'Target');
  if (targets.length === 0) throw new Error(`工程里没有 <Target>: ${file}`);
  const targetNode = targetName
    ? targets.find((t) => childText(t, 'TargetName') === targetName)
    : targets[0];
  if (!targetNode) {
    throw new Error(`找不到目标 "${targetName}"；可用: ${targets.map((t) => childText(t, 'TargetName')).join(', ')}`);
  }

  const common = findPath(targetNode, ['TargetOption', 'TargetCommonOption']) ?? targetNode;
  const armAds = child(targetNode, 'TargetOption') ? findPath(targetNode, ['TargetOption', 'TargetArmAds']) : null;
  const cads = armAds ? child(armAds, 'Cads') : null;
  const various = cads ? child(cads, 'VariousControls') : null;
  const aadsVarious = armAds && child(armAds, 'Aads') ? child(child(armAds, 'Aads'), 'VariousControls') : null;
  const ldads = armAds ? child(armAds, 'LDads') : null;

  const outputDir = childText(common, 'OutputDirectory') || 'Objects';
  const outputName = childText(common, 'OutputName') || childText(targetNode, 'TargetName');
  const listingPath = childText(common, 'ListingPath');
  const outDirAbs = resolve(projectDir, outputDir);
  const elfPath = join(outDirAbs, `${outputName}.axf`);
  const hexPath = join(outDirAbs, `${outputName}.hex`);

  const defineText = various ? childText(various, 'Define') : '';
  const includeText = various ? childText(various, 'IncludePath') : '';
  const misc = various ? childText(various, 'MiscControls') : '';
  const asmMisc = aadsVarious ? childText(aadsVarious, 'MiscControls') : '';
  const asmDefine = aadsVarious ? childText(aadsVarious, 'Define') : '';

  const groups = [];
  const files = [];
  for (const groupNode of findAll(targetNode, 'Group')) {
    const groupName = childText(groupNode, 'GroupName');
    const groupFiles = [];
    for (const fileNode of children(child(groupNode, 'Files'), 'File')) {
      const name = childText(fileNode, 'FileName');
      const rel = childText(fileNode, 'FilePath');
      if (!rel) continue;
      const abs = resolve(projectDir, rel.replace(/\\/g, '/'));
      const kind = inputTypeLabel(childText(fileNode, 'FileType'), name.split('.').pop());
      const entry = { group: groupName, name, path: rel, abs, kind };
      groupFiles.push(entry);
      files.push(entry);
    }
    groups.push({ name: groupName, files: groupFiles });
  }

  const cpu = parseCpuLine(childText(common, 'Cpu'));
  const debuggerInfo = parseDebugOption(targetNode);
  const uac6 = findAll(targetNode, 'uAC6')[0]?.text.trim() === '1';
  const pccUsed = findAll(targetNode, 'pCCUsed')[0]?.text.trim() ?? '';
  const scatterFile = ldads ? childText(ldads, 'ScatterFile') : '';
  const linkerMisc = ldads ? childText(ldads, 'Misc') : '';

  return {
    path: resolve(file),
    dir: projectDir,
    target: childText(targetNode, 'TargetName'),
    targets: targets.map((t) => childText(t, 'TargetName')),
    toolset: childText(targetNode, 'ToolsetName'),
    device: childText(common, 'Device'),
    vendor: childText(common, 'Vendor'),
    pack: childText(common, 'PackID'),
    cpu,
    output: {
      dir: outputDir,
      dirAbs: outDirAbs,
      name: outputName,
      listingPath: listingPath ? resolve(projectDir, listingPath) : '',
      createHex: childText(common, 'CreateHexFile') === '1',
      debugInfo: childText(common, 'DebugInformation') === '1',
      elf: elfPath,
      hex: hexPath,
    },
    compiler: {
      uac6,
      pccUsed,
      optimization: cads ? childText(cads, 'Optim') : '',
      cstd: cads ? childText(cads, 'Cstd') : '',
      defines: splitList(defineText),
      includes: splitList(includeText).map((p) => resolve(projectDir, p.replace(/\\/g, '/'))),
      misc,
      asmDefines: splitList(asmDefine),
      asmMisc,
      scatterFile: scatterFile ? resolve(projectDir, scatterFile.replace(/\\/g, '/')) : '',
      linkerMisc,
    },
    debugger: {
      ...debuggerInfo,
      recommendedInterface: openocdInterfaceForDebugger(debuggerInfo),
      recommendedTarget: openocdTargetForDevice(childText(common, 'Device')),
    },
    groups,
    files,
    sourceCount: files.length,
    raw: { cpu: cpu.raw },
  };
}
