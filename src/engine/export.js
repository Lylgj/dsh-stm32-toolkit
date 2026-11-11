/**
 * Keil .uvprojx -> CMake/GCC export.
 *
 * Lets a machine without Keil MDK still build a Keil project: sources, include
 * paths and defines are copied from the project file, Keil's ARM assembler
 * startup / scatter files are replaced with a generated GNU startup and linker
 * script, and the result is a self-contained CMake project.
 *
 * Only the common case is covered: C/C++/assembly sources that already build
 * with GCC. ARMCC-only sources (e.g. FreeRTOS RVDS ports) are remapped to their
 * GCC sibling when the pack ships one, otherwise they are left out and reported.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ensureDir } from '../util.js';
import { STARTUP_ASM } from './ioc.js';

/** GCC flags matching the .uvprojx CPU description. */
export function gnuFlagsFor(cpu = {}) {
  const core = String(cpu.core ?? 'Cortex-M4').toLowerCase();
  const fpu = Number(cpu.fpu ?? 0);
  if (core.includes('m0+') || core.includes('m0plus')) return '-mcpu=cortex-m0plus -mthumb';
  if (core.includes('m0')) return '-mcpu=cortex-m0 -mthumb';
  if (core.includes('m33')) return '-mcpu=cortex-m33 -mthumb -mfloat-abi=hard -mfpu=fpv5-sp-d16';
  if (core.includes('m3')) return '-mcpu=cortex-m3 -mthumb';
  if (core.includes('m7')) return `-mcpu=cortex-m7 -mthumb${fpu > 0 ? ' -mfloat-abi=hard -mfpu=fpv5-d16' : ''}`;
  if (core.includes('m4')) return `-mcpu=cortex-m4 -mthumb${fpu > 0 ? ' -mfloat-abi=hard -mfpu=fpv4-sp-d16' : ''}`;
  return '-mcpu=cortex-m4 -mthumb';
}

function isStartup(name) {
  return /(^|[\\/])startup[^\\/]*\.s$/i.test(name);
}

/**
 * `portable/RVDS/ARM_CM4F` -> `portable/GCC/ARM_CM4F` when the GCC sibling
 * exists. The same swap applies to include dirs: the RVDS dir ships ARMCC-only
 * headers that GCC cannot parse.
 */
function remapRvdPath(p) {
  if (!/[\\/]portable[\\/]RVDS[\\/]/i.test(p)) return p;
  const gccPath = p.replace(/[\\/]RVDS[\\/]/i, (part) => part.replace(/RVDS/i, 'GCC'));
  return existsSync(gccPath) ? gccPath : p;
}

const CMSIS_SKIP_DIRS = new Set(['.git', 'node_modules', 'build', '.dsh-gcc', 'Objects', 'Listings', 'Debug', 'Release']);

function hasCmsisCoreHeaders(dir) {
  try {
    const names = readdirSync(dir);
    // cmsis_gcc.h / cmsis_armcc.h live beside core_cm*.h in CMSIS 5.
    if (names.includes('cmsis_gcc.h')) return true;
    return names.some((name) => /^core_cm\w*\.h$/i.test(name));
  } catch {
    return false;
  }
}

/**
 * Keil takes CMSIS core headers (core_cm4.h, cmsis_gcc.h) from the DFP pack,
 * so they are usually absent from the .uvprojx include list. When the project
 * keeps them in-tree (Drivers/CMSIS/Include), add that directory so GCC can
 * find them.
 */
function findCmsisIncludeDir(root, includes) {
  for (const dir of includes) {
    if (dir && hasCmsisCoreHeaders(dir)) return null; // already covered
  }
  const known = [
    'Drivers/CMSIS/Include',
    'Drivers/CMSIS/Core/Include',
    'CMSIS/Include',
    'Middlewares/Third_Party/CMSIS/Include',
  ];
  for (const rel of known) {
    const dir = join(root, rel);
    if (hasCmsisCoreHeaders(dir)) return dir;
  }
  const walk = (dir, depth) => {
    if (depth > 5) return null;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    if (entries.some((e) => e.isFile() && (/^(core_cm\w*\.h|cmsis_gcc\.h)$/i.test(e.name)))) return dir;
    for (const entry of entries) {
      if (!entry.isDirectory() || CMSIS_SKIP_DIRS.has(entry.name)) continue;
      const hit = walk(join(dir, entry.name), depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, 0);
}

/**
 * Select the sources that can go through GCC and note what was dropped.
 * FreeRTOS-style `portable/RVDS/` files are redirected to their GCC siblings.
 */
export function selectSources(uvprojx) {
  const sources = [];
  const skipped = [];
  const remapped = [];
  for (const file of uvprojx.files ?? []) {
    const name = file.name || basename(file.abs || '');
    const abs = file.abs || '';
    if (!abs) {
      skipped.push({ name, reason: '路径缺失' });
      continue;
    }
    if (/\.sct$/i.test(name)) {
      skipped.push({ name, reason: 'Keil 分散加载文件' });
      continue;
    }
    if (isStartup(name)) {
      skipped.push({ name, reason: 'Keil 汇编启动文件（已用 GNU 启动文件替代）' });
      continue;
    }
    if (!existsSync(abs)) {
      skipped.push({ name, reason: '文件不存在' });
      continue;
    }
    const gccPath = remapRvdPath(abs);
    if (gccPath !== abs) {
      remapped.push({ from: abs, to: gccPath });
      sources.push(gccPath);
      continue;
    }
    if (/[\\/]portable[\\/]RVDS[\\/]/i.test(abs)) {
      skipped.push({ name, reason: 'ARMCC 专用移植层，没有对应的 GCC 版本' });
      continue;
    }
    sources.push(abs);
  }
  return { sources, skipped, remapped };
}

function linkerScript(uvprojx, name) {
  const rom = uvprojx.cpu?.rom?.[0] ?? { start: 0x08000000, size: 0x100000 };
  const ram = uvprojx.cpu?.ram?.[0] ?? { start: 0x20000000, size: 0x20000 };
  const hex = (value) => `0x${Number(value).toString(16).toUpperCase()}`;
  return `/* Generated by dsh-stm32-toolkit from ${name}.uvprojx */
ENTRY(Reset_Handler)
_estack = ORIGIN(RAM) + LENGTH(RAM);
_Min_Heap_Size = 0x200;
_Min_Stack_Size = 0x400;

MEMORY
{
  FLASH (rx)  : ORIGIN = ${hex(rom.start)}, LENGTH = ${Math.round(rom.size / 1024)}K
  RAM   (rwx) : ORIGIN = ${hex(ram.start)}, LENGTH = ${Math.round(ram.size / 1024)}K
}

SECTIONS
{
  .isr_vector : { KEEP(*(.isr_vector)) } > FLASH
  .text : {
    *(.text*)
    *(.rodata*)
    . = ALIGN(4);
    _etext = .;
  } > FLASH
  _sidata = LOADADDR(.data);
  .data : {
    _sdata = .;
    *(.data*)
    . = ALIGN(4);
    _edata = .;
  } > RAM AT > FLASH
  .bss : {
    _sbss = .;
    *(.bss*)
    *(COMMON)
    . = ALIGN(4);
    _ebss = .;
  } > RAM
  ._user_heap_stack : {
    . = ALIGN(8);
    PROVIDE(end = .);
    . = . + _Min_Heap_Size;
    . = . + _Min_Stack_Size;
    . = ALIGN(8);
  } > RAM
}
`;
}

function cmakeLists(uvprojx, name, sources, includes, defines) {
  const flags = gnuFlagsFor(uvprojx.cpu);
  const device = uvprojx.device || 'stm32';
  const list = (items) => items.map((item) => `"${String(item).replace(/\\/g, '/')}"`).join('\n  ');
  const includeList = list(includes.map((dir) => remapRvdPath(dir)));
  return `# Generated by dsh-stm32-toolkit from ${name}.uvprojx
# Device: ${device}
cmake_minimum_required(VERSION 3.20)

set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR arm)
set(CMAKE_C_COMPILER arm-none-eabi-gcc)
set(CMAKE_ASM_COMPILER arm-none-eabi-gcc)
set(CMAKE_OBJCOPY arm-none-eabi-objcopy)
set(CMAKE_SIZE arm-none-eabi-size)
set(CMAKE_C_STANDARD 11)

project(${name} C ASM)

set(MCU_FLAGS ${flags})

add_executable(${name}.elf
  ${list(sources)}
  "${join('.', 'startup_stm32.s').replace(/\\/g, '/')}"
)

target_include_directories(${name}.elf PRIVATE
  ${includeList}
  "\${CMAKE_CURRENT_SOURCE_DIR}"
)

target_compile_definitions(${name}.elf PRIVATE
  ${list(defines)}
)

target_compile_options(${name}.elf PRIVATE
  \${MCU_FLAGS}
  -O1 -g -Wall -ffunction-sections -fdata-sections
  -Wno-unused-parameter -Wno-sign-compare
  # Keil/AC5 accepted these; GCC >= 14 turned them into hard errors.
  -Wno-int-conversion -Wno-incompatible-pointer-types -Wno-implicit-function-declaration
)

target_link_options(${name}.elf PRIVATE
  \${MCU_FLAGS}
  -T\${CMAKE_CURRENT_SOURCE_DIR}/linker.ld
  -Wl,--gc-sections
  -Wl,-Map=\${PROJECT_NAME}.map
  --specs=nano.specs
  --specs=nosys.specs
)

# -lm must come after the objects, so use the library form rather than a flag.
target_link_libraries(${name}.elf PRIVATE m)

add_custom_command(TARGET ${name}.elf POST_BUILD
  COMMAND \${CMAKE_OBJCOPY} -O ihex $<TARGET_FILE:${name}.elf> ${name}.hex
  COMMAND \${CMAKE_OBJCOPY} -O binary $<TARGET_FILE:${name}.elf> ${name}.bin
  COMMAND \${CMAKE_SIZE} $<TARGET_FILE:${name}.elf>)
`;
}

/**
 * Export a Keil project to a CMake tree.
 *
 * @param {object} projectInfo result of inspectProject()
 * @param {{dir?:string}} [options]
 * @returns {{dir:string, buildDir:string, files:string[], sources:number, skipped:object[], remapped:object[]}}
 */
export function exportKeilToCmake(projectInfo, options = {}) {
  const uvprojx = projectInfo.uvprojx ?? projectInfo;
  if (!uvprojx || !uvprojx.files) throw new Error('不是有效的 Keil 工程，无法导出 CMake');
  const dir = options.dir || join(uvprojx.dir || projectInfo.root || '.', '.dsh-gcc');
  ensureDir(dir);
  const name = (uvprojx.output?.name || uvprojx.target || 'firmware').replace(/[^\w.-]/g, '_');
  const { sources, skipped, remapped } = selectSources(uvprojx);
  if (!sources.length) throw new Error('Keil 工程里没有可用的 C/C++/汇编源文件');
  const includes = [...(uvprojx.compiler?.includes ?? [])];
  const defines = uvprojx.compiler?.defines ?? [];
  // CMSIS core headers usually come from the Keil DFP pack, never from the
  // .uvprojx include list — add the in-tree copy when it exists.
  const searchRoots = [projectInfo.root, uvprojx.dir, uvprojx.dir && dirname(uvprojx.dir)].filter(Boolean);
  let cmsisDir = null;
  for (const root of searchRoots) {
    cmsisDir = findCmsisIncludeDir(root, includes);
    if (cmsisDir) break;
  }
  if (cmsisDir && !includes.includes(cmsisDir)) includes.push(cmsisDir);
  const files = {
    [join(dir, 'CMakeLists.txt')]: cmakeLists(uvprojx, name, sources, includes, defines),
    [join(dir, 'linker.ld')]: linkerScript(uvprojx, name),
    [join(dir, 'startup_stm32.s')]: STARTUP_ASM,
    [join(dir, 'README.md')]: `# ${name} (exported by dsh-stm32-toolkit)\n\n`
      + `Generated from \`${uvprojx.path}\`.\n\n`
      + `${sources.length} source files, ${includes.length} include dirs, ${defines.length} defines.\n\n`
      + '```powershell\ncmake -S . -B build -G Ninja\ncmake --build build\n```\n',
  };
  for (const [file, content] of Object.entries(files)) {
    let previous = null;
    try {
      previous = readFileSync(file, 'utf8');
    } catch {
      /* new file */
    }
    if (previous !== content) writeFileSync(file, content, 'utf8');
  }
  return {
    dir,
    buildDir: join(dir, 'build'),
    name,
    files: Object.keys(files),
    sources: sources.length,
    includes: includes.length,
    defines: defines.length,
    skipped,
    remapped,
  };
}
