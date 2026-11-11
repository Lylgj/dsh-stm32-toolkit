/**
 * STM32CubeMX `.ioc` support plus a small project generator.
 *
 * `parseIoc` is tolerant: CubeMX writes `KEY=VALUE` lines in an order that is
 * meaningful only to CubeMX itself, so we keep the original entries for
 * read-modify-write and only derive a pin/peripheral summary.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, fileExists } from '../util.js';

const PIN_KEY = /^Mcu\.Pin(\d+)(?:\.([A-Za-z0-9_]+))?$/;

/** Parse `.ioc` text into entries + a derived summary. */
export function parseIoc(text, file = '') {
  const raw = String(text);
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    entries.push({ key: line.slice(0, index).trim(), value: line.slice(index + 1).trim(), line });
  }
  const get = (key) => entries.find((entry) => entry.key === key)?.value ?? '';
  const pinMap = new Map();
  for (const entry of entries) {
    const match = PIN_KEY.exec(entry.key);
    if (!match) continue;
    const index = Number(match[1]);
    const pin = pinMap.get(index) ?? { index, pin: '', signal: '', label: '', mode: '', locked: '' };
    if (!match[2]) pin.pin = entry.value;
    else if (match[2] === 'Signal') pin.signal = entry.value;
    else if (match[2] === 'GPIO_Label') pin.label = entry.value;
    else if (match[2] === 'Mode') pin.mode = entry.value;
    else if (match[2] === 'Locked') pin.locked = entry.value;
    pinMap.set(index, pin);
  }
  const peripherals = entries
    .filter((entry) => /^Mcu\.IP\d+$/.test(entry.key))
    .map((entry) => entry.value)
    .filter((value) => value && value !== 'Nb');
  return {
    file,
    mcu: { name: get('Mcu.Name'), package: get('Mcu.Package'), userName: get('Mcu.UserName') },
    project: {
      name: get('ProjectManager.ProjectName'),
      deviceId: get('ProjectManager.DeviceId'),
      toolchain: get('ProjectManager.ToolChain'),
      firmwarePackage: get('ProjectManager.FirmwarePackage'),
    },
    pins: [...pinMap.values()].sort((a, b) => a.index - b.index),
    peripherals: [...new Set(peripherals)],
    entries,
    raw,
  };
}

/** Set one key (replace in place or append). */
export function setIocValue(text, key, value) {
  const lines = String(text).split(/\r?\n/);
  let replaced = false;
  const next = lines.map((line) => {
    if (!replaced && line.startsWith(`${key}=`)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) {
    // Append before the trailing empty line, if any.
    const tail = next.length && next[next.length - 1] === '' ? next.pop() : null;
    next.push(`${key}=${value}`);
    if (tail !== null) next.push(tail);
  }
  return next.join('\n');
}

/** Serialize entries back into `.ioc` text (keeps original order). */
export function serializeIoc(parsed) {
  return parsed.entries.map((entry) => `${entry.key}=${entry.value}`).join('\r\n') + '\r\n';
}

/** Read/write helpers used by the tools and HTTP routes. */
export function loadIoc(file) {
  return parseIoc(readFileSync(file, 'utf8'), file);
}

const MEMORY = [
  [/STM32F407VG|STM32F405VG|STM32F415VG|STM32F417VG/i, { flash: 1024, ram: 128 }],
  [/STM32F429|STM32F439/i, { flash: 2048, ram: 256 }],
  [/STM32F401/i, { flash: 512, ram: 96 }],
  [/STM32F103C8/i, { flash: 64, ram: 20 }],
  [/STM32F103/i, { flash: 128, ram: 20 }],
  [/STM32L476|STM32L496/i, { flash: 1024, ram: 128 }],
  [/STM32G431|STM32G474/i, { flash: 128, ram: 32 }],
  [/STM32H743|STM32H750|STM32H723|STM32H725|STM32H745|STM32H747|STM32H755|STM32H757/i, { flash: 2048, ram: 1024 }],
  [/STM32WB55/i, { flash: 1024, ram: 256 }],
  [/STM32U575|STM32U585/i, { flash: 2048, ram: 786 }],
];

export function memoryForDevice(device) {
  const name = String(device ?? '');
  for (const [pattern, memory] of MEMORY) {
    if (pattern.test(name)) return { flashKb: memory.flash, ramKb: memory.ram, dualCore: /STM32H7(45|47|55|57)/i.test(name) };
  }
  return { flashKb: 512, ramKb: 128, dualCore: /STM32H7(45|47|55|57)/i.test(name) };
}

function devicePackage(device) {
  const name = String(device ?? '').toUpperCase();
  if (/V[GT]/.test(name)) return 'LQFP100';
  if (/Z[GT]/.test(name)) return 'LQFP144';
  if (/I[GT]/.test(name)) return 'LQFP176';
  if (/R[GT]/.test(name)) return 'LQFP64';
  if (/C[GT]/.test(name)) return 'LQFP48';
  return 'LQFP100';
}

/** Minimal but CubeMX-shaped `.ioc` for a fresh project. */
export function createIoc({ device, projectName = 'stm32_project', ledPin = 'PA5' }) {
  const mcu = String(device || 'STM32F407VGTx');
  const lines = [
    '#MicroXplorer Configuration settings - do not modify',
    'Mcu.IP0=RCC',
    'Mcu.IP1=SYS',
    'Mcu.IPNb=2',
    `Mcu.Name=${mcu}`,
    `Mcu.Package=${devicePackage(mcu)}`,
    `Mcu.Pin0=${ledPin}`,
    'Mcu.Pin0.GPIO_Label=LED',
    'Mcu.Pin0.Locked=true',
    'Mcu.Pin0.Signal=GPIO_Output',
    'Mcu.PinNb=1',
    `Mcu.UserName=${mcu}`,
    `ProjectManager.DeviceId=${mcu}`,
    'ProjectManager.FirmwarePackage=STM32Cube FW_F4 V1.28.0',
    `ProjectManager.ProjectName=${projectName}`,
    'ProjectManager.ToolChain=CMake',
    'ProjectManager.UnderRoot=true',
    'board=custom',
    '',
  ];
  return lines.join('\r\n');
}

export const STARTUP_ASM = `  .syntax unified
  .cpu cortex-m4
  .thumb

  .global g_pfnVectors
  .global Reset_Handler

  .section .isr_vector,"a",%progbits
  .type g_pfnVectors, %object
g_pfnVectors:
  .word _estack
  .word Reset_Handler
  .word NMI_Handler
  .word HardFault_Handler
  .word MemManage_Handler
  .word BusFault_Handler
  .word UsageFault_Handler
  .word 0
  .word 0
  .word 0
  .word 0
  .word SVC_Handler
  .word DebugMon_Handler
  .word 0
  .word PendSV_Handler
  .word SysTick_Handler
  .rept 96
  .word Default_Handler
  .endr
  .size g_pfnVectors, .-g_pfnVectors

  .section .text.Reset_Handler,"ax",%progbits
  .type Reset_Handler, %function
Reset_Handler:
  ldr r0, =_sidata
  ldr r1, =_sdata
  ldr r2, =_edata
1:
  cmp r1, r2
  bcs 2f
  ldr r3, [r0], #4
  str r3, [r1], #4
  b 1b
2:
  ldr r0, =_sbss
  ldr r1, =_ebss
  movs r3, #0
3:
  cmp r0, r1
  bcs 4f
  str r3, [r0], #4
  b 3b
4:
  bl main
5:
  b 5b
  .size Reset_Handler, .-Reset_Handler

  .macro weak_handler name
  .weak \\name
  .thumb_set \\name, Default_Handler
  .endm

  weak_handler NMI_Handler
  weak_handler HardFault_Handler
  weak_handler MemManage_Handler
  weak_handler BusFault_Handler
  weak_handler UsageFault_Handler
  weak_handler SVC_Handler
  weak_handler DebugMon_Handler
  weak_handler PendSV_Handler
  weak_handler SysTick_Handler

  .section .text.Default_Handler,"ax",%progbits
  .type Default_Handler, %function
Default_Handler:
  b Default_Handler
  .size Default_Handler, .-Default_Handler
`;

function linkerScript(device, memory) {
  return `/* Generated by dsh-stm32-toolkit for ${device} */
ENTRY(Reset_Handler)
_estack = ORIGIN(RAM) + LENGTH(RAM);

MEMORY
{
  FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = ${memory.flashKb}K
  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = ${memory.ramKb}K
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
  end = .;
}
`;
}

function mainC(device, ledPin) {
  const port = String(ledPin).slice(0, 2).toUpperCase();
  const pin = Number(String(ledPin).slice(2)) || 5;
  const portIndex = port.charCodeAt(1) - 65; // 'A' -> 0
  const base = 0x40020000 + portIndex * 0x400;
  const rccEnr = 0x40023830;
  const bit = 1 << portIndex;
  const modeShift = pin * 2;
  return `/* Register-level blinky for ${device} (generated by dsh-stm32-toolkit). */
#define REG32(addr) (*(volatile unsigned int *)(addr))

#define RCC_AHB1ENR REG32(${hex32(rccEnr)})
#define GPIO_MODER  REG32(${hex32(base + 0x00)})
#define GPIO_ODR    REG32(${hex32(base + 0x14)})

static void delay(volatile unsigned int count) {
  while (count-- > 0) {
    __asm volatile ("nop");
  }
}

int main(void) {
  RCC_AHB1ENR |= (1u << ${portIndex});
  unsigned int moder = GPIO_MODER;
  moder &= ~(3u << ${modeShift});
  moder |= (1u << ${modeShift});
  GPIO_MODER = moder;

  for (;;) {
    GPIO_ODR ^= (1u << ${pin});
    delay(800000);
  }
}
`;
}

function hex32(value) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

/** GCC CPU/FPU flags for the common STM32 cores. */
export function cpuFlagsFor(device) {
  const name = String(device ?? '').toUpperCase();
  if (/STM32H7|STM32F7/.test(name)) return '-mcpu=cortex-m7 -mthumb -mfloat-abi=hard -mfpu=fpv5-d16';
  if (/STM32U5|STM32L5/.test(name)) return '-mcpu=cortex-m33 -mthumb -mfloat-abi=hard -mfpu=fpv5-sp-d16';
  if (/STM32F4|STM32F3|STM32L4|STM32G4|STM32WB/.test(name)) return '-mcpu=cortex-m4 -mthumb -mfloat-abi=hard -mfpu=fpv4-sp-d16';
  if (/STM32F1|STM32F2|STM32L1/.test(name)) return '-mcpu=cortex-m3 -mthumb';
  if (/STM32G0|STM32C0|STM32L0|STM32F0|STM32WL/.test(name)) return '-mcpu=cortex-m0plus -mthumb';
  return '-mcpu=cortex-m4 -mthumb -mfloat-abi=hard -mfpu=fpv4-sp-d16';
}

function cmakeLists(projectName, device, memory) {
  const flags = cpuFlagsFor(device);
  return `cmake_minimum_required(VERSION 3.20)

set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR arm)
set(CMAKE_C_COMPILER arm-none-eabi-gcc)
set(CMAKE_ASM_COMPILER arm-none-eabi-gcc)
set(CMAKE_OBJCOPY arm-none-eabi-objcopy)
set(CMAKE_SIZE arm-none-eabi-size)

project(${projectName} C ASM)

set(MCU_FLAGS "${flags}")
set(CMAKE_C_FLAGS "\${MCU_FLAGS} -O2 -g -Wall -ffunction-sections -fdata-sections -D${device} \${CMAKE_C_FLAGS}")
set(CMAKE_ASM_FLAGS "\${MCU_FLAGS} \${CMAKE_ASM_FLAGS}")
set(CMAKE_EXE_LINKER_FLAGS "\${MCU_FLAGS} -T\${CMAKE_SOURCE_DIR}/linker.ld -Wl,--gc-sections -Wl,-Map=\${PROJECT_NAME}.map --specs=nano.specs --specs=nosys.specs \${CMAKE_EXE_LINKER_FLAGS}")

add_executable(${projectName}.elf src/main.c src/startup_stm32.s)
set_target_properties(${projectName}.elf PROPERTIES LINK_DEPENDS \${CMAKE_SOURCE_DIR}/linker.ld)
add_custom_command(TARGET ${projectName}.elf POST_BUILD
  COMMAND \${CMAKE_OBJCOPY} -O ihex $<TARGET_FILE:${projectName}.elf> ${projectName}.hex
  COMMAND \${CMAKE_OBJCOPY} -O binary $<TARGET_FILE:${projectName}.elf> ${projectName}.bin
  COMMAND \${CMAKE_SIZE} $<TARGET_FILE:${projectName}.elf>)
`;
}

/**
 * Generate a minimal CMake + register-level project that builds with
 * `arm-none-eabi-gcc` and flashes with OpenOCD.
 */
export function generateProject(dir, options = {}) {
  const device = options.device || 'STM32F407VGTx';
  const projectName = options.name || 'stm32_project';
  const memory = memoryForDevice(device);
  ensureDir(dir);
  ensureDir(join(dir, 'src'));
  const files = {
    [join(dir, `${projectName}.ioc`)]: createIoc({ device, projectName, ledPin: options.ledPin || 'PA5' }),
    [join(dir, 'CMakeLists.txt')]: cmakeLists(projectName, device, memory),
    [join(dir, 'linker.ld')]: linkerScript(device, memory),
    [join(dir, 'src', 'main.c')]: mainC(device, options.ledPin || 'PA5'),
    [join(dir, 'src', 'startup_stm32.s')]: STARTUP_ASM,
    [join(dir, 'README.md')]: `# ${projectName}\n\nGenerated by dsh-stm32-toolkit.\n\n- Device: ${device}\n- Flash: ${memory.flashKb} KB / RAM: ${memory.ramKb} KB\n\n\`\`\`powershell\ncmake -S . -B build -G Ninja\ncmake --build build\n\`\`\`\n`,
  };
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(file, content, 'utf8');
  }
  return {
    dir,
    device,
    projectName,
    files: Object.keys(files),
    memory,
    ioc: files[join(dir, `${projectName}.ioc`)],
    exists: fileExists(join(dir, `${projectName}.ioc`)),
  };
}
