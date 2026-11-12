import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exportKeilToCmake } from '../src/engine/export.js';
import { listDirectory } from '../src/index.js';
import {
  cpuFlagsFor,
  createIoc,
  generateProject,
  memoryForDevice,
  parseIoc,
  setIocValue,
} from '../src/engine/ioc.js';
import { findInstalledBinaries, pickReleaseAsset } from '../src/engine/install.js';
import { buildPinMap, parsePinAssignments } from '../src/engine/pins.js';
import {
  findSymbols,
  loadSymbolFile,
  lookupAddress,
  parseKeilMap,
  parseNmOutput,
} from '../src/engine/symbols.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'stm32-features-'));
const SAMPLE_C = `
void MX_GPIO_Init(void) {
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5, GPIO_PIN_SET);
  HAL_GPIO_TogglePin(GPIOB, GPIO_PIN_0);
  GPIO_InitStruct.Pin = GPIO_PIN_5|GPIO_PIN_6;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);
}
`;

test('parseIoc derives pins, mcu and peripherals', () => {
  const text = [
    '#MicroXplorer Configuration settings - do not modify',
    'Mcu.IP0=RCC',
    'Mcu.IP1=GPIO',
    'Mcu.IPNb=2',
    'Mcu.Name=STM32F407VGTx',
    'Mcu.Package=LQFP100',
    'Mcu.Pin0=PA5',
    'Mcu.Pin0.GPIO_Label=LED',
    'Mcu.Pin0.Signal=GPIO_Output',
    'Mcu.Pin1=PC13',
    'Mcu.Pin1.Mode=GPIO_Mode_Output',
    'ProjectManager.ProjectName=blinky',
    'ProjectManager.DeviceId=STM32F407VGTx',
    'ProjectManager.ToolChain=CMake',
    '',
  ].join('\r\n');
  const parsed = parseIoc(text, 'blinky.ioc');
  assert.equal(parsed.mcu.name, 'STM32F407VGTx');
  assert.equal(parsed.mcu.package, 'LQFP100');
  assert.equal(parsed.project.name, 'blinky');
  assert.deepEqual(parsed.peripherals.sort(), ['GPIO', 'RCC']);
  assert.equal(parsed.pins.length, 2);
  assert.deepEqual(parsed.pins[0], {
    index: 0, pin: 'PA5', signal: 'GPIO_Output', label: 'LED', mode: '', locked: '',
  });
  assert.equal(parsed.pins[1].pin, 'PC13');
});

test('setIocValue replaces in place and appends missing keys', () => {
  const text = 'A=1\r\nB=2\r\n';
  const replaced = setIocValue(text, 'B', '3');
  assert.match(replaced, /B=3/);
  const appended = setIocValue(replaced, 'C', '4');
  assert.match(appended, /C=4/);
  assert.ok(appended.trim().endsWith('C=4'));
});

test('memory and generated project describe the device', () => {
  const big = memoryForDevice('STM32H745VITx');
  assert.equal(big.dualCore, true);
  const f407 = memoryForDevice('STM32F407VGTx');
  assert.equal(f407.flashKb, 1024);
  assert.equal(f407.ramKb, 128);

  const ioc = createIoc({ device: 'STM32F407VGTx', projectName: 'demo', ledPin: 'PA5' });
  assert.match(ioc, /Mcu\.Name=STM32F407VGTx/);
  assert.match(ioc, /ProjectManager\.ProjectName=demo/);

  const dir = join(tempDir(), 'demo');
  const result = generateProject(dir, { device: 'STM32F407VGTx', name: 'demo', ledPin: 'PA5' });
  assert.ok(result.exists);
  for (const file of ['demo.ioc', 'CMakeLists.txt', 'linker.ld', join('src', 'main.c'), join('src', 'startup_stm32.s')]) {
    assert.ok(existsSync(join(dir, file)), `missing ${file}`);
  }
  assert.ok(existsSync(join(dir, 'demo.ioc')));

  const cmake = readFileSync(join(dir, 'CMakeLists.txt'), 'utf8');
  assert.ok(cmake.indexOf('set(CMAKE_C_COMPILER') < cmake.indexOf('project(demo'), 'compiler must be set before project()');
  assert.match(cmake, /--specs=nosys\.specs/);
  assert.match(cmake, /-mcpu=cortex-m4/);
  assert.match(cpuFlagsFor('STM32H745VITx'), /cortex-m7/);
  assert.match(cpuFlagsFor('STM32G071RBTx'), /cortex-m0plus/);
});

test('Keil map parsing, lookup and name search', () => {
  const map = [
    '    Image Symbol Table',
    '    Local Symbols',
    '    Symbol Name                              Value     Obj  Flags',
    '    main                                     0x08000c4d   Thumb Code   132  main.o(.text.main)',
    '    SystemClock_Config                       0x08000411   Thumb Code   224  system_stm32f4xx.o(.text)',
    '    Image component sizes',
    '',
  ].join('\n');
  const parsed = parseKeilMap(map);
  assert.equal(parsed.symbols.length, 2);
  assert.equal(parsed.source, 'keil-map');
  assert.equal(parsed.symbols[0].name, 'main');
  assert.equal(parsed.symbols[0].address, 0x08000c4d);
  assert.equal(parsed.symbols[0].size, 132);

  const hit = lookupAddress(parsed.symbols, 0x08000c4d + 16);
  assert.equal(hit.name, 'main');
  assert.equal(hit.offset, 16);
  assert.equal(lookupAddress(parsed.symbols, 0x08000c4d + 500), null);

  const found = findSymbols(parsed.symbols, 'system');
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'SystemClock_Config');
});

test('nm output parsing and loadSymbolFile on a real map file', () => {
  const nm = [
    '08000c4d 00000084 T main',
    '20000004 00000004 B counter',
  ].join('\n');
  const parsed = parseNmOutput(nm);
  assert.equal(parsed.symbols.length, 2);
  assert.equal(parsed.symbols[0].name, 'main');
  assert.equal(parsed.symbols[1].type, 'B');

  const dir = tempDir();
  const file = join(dir, 'demo.map');
  writeFileSync(file, '    Image Symbol Table\n    main  0x08000c4d  Thumb Code  132  main.o(.text.main)\n', 'utf8');
  const loaded = loadSymbolFile(file);
  assert.equal(loaded.source, 'keil-map');
  assert.equal(loaded.file, file);
  assert.equal(loaded.symbols[0].name, 'main');
});

test('pin map merges source init blocks and .ioc pins', () => {
  const pins = parsePinAssignments([{ file: 'gpio.c', text: SAMPLE_C }]);
  const pa = pins.find((pin) => pin.port === 'GPIOA' && pin.pin === 5);
  assert.ok(pa, 'GPIOA init block parsed');
  assert.equal(pa.mode, 'GPIO_MODE_OUTPUT_PP');
  const hint = pins.find((pin) => pin.port === 'GPIOB' && pin.pin === 0);
  assert.ok(hint, 'TogglePin hint recorded');
  assert.equal(hint.mode, 'used');

  const dir = tempDir();
  writeFileSync(join(dir, 'gpio.c'), SAMPLE_C, 'utf8');
  const ioc = parseIoc('Mcu.Pin0=PB0\r\nMcu.Pin0.Signal=GPIO_Output\r\nMcu.Pin0.GPIO_Label=BTN\r\n', 'x.ioc');
  const map = buildPinMap(dir, ioc);
  const pb = map.pins.find((pin) => pin.port === 'GPIOB' && pin.pin === 0);
  assert.ok(pb);
  assert.equal(pb.mode, 'GPIO_Output');
  assert.equal(pb.label, 'BTN');
  assert.ok(map.pins.some((pin) => pin.port === 'GPIOA' && pin.pin === 5));
});

test('pin map resolves #define names and static pin tables', () => {
  const text = [
    '#define LED_PORT GPIOE',
    '#define LED1_PIN GPIO_PIN_2',
    '#define LED2_PIN GPIO_PIN_3',
    'typedef struct { GPIO_TypeDef *GPIOx; uint16_t GPIO_Pin; } LED;',
    'static LED leds[] = { {LED_PORT, LED1_PIN}, {GPIOE, LED2_PIN} };',
    'void init(void) {',
    '  GPIO_InitTypeDef s;',
    '  s.Mode = GPIO_MODE_OUTPUT_PP;',
    '  s.Pull = GPIO_NOPULL;',
    '  for (int i = 0; i < 2; i++) {',
    '    s.Pin = leds[i].GPIO_Pin;',
    '    HAL_GPIO_Init(leds[i].GPIOx, &s);',
    '  }',
    '}',
  ].join('\n');
  const pins = parsePinAssignments([{ file: 'led.c', text }]);
  const pe2 = pins.find((pin) => pin.port === 'GPIOE' && pin.pin === 2);
  const pe3 = pins.find((pin) => pin.port === 'GPIOE' && pin.pin === 3);
  assert.ok(pe2, 'macro port/pin resolved from table');
  assert.ok(pe3, 'array entry with macro pin resolved');
  assert.equal(pe2.mode, 'GPIO_MODE_OUTPUT_PP');

  const direct = parsePinAssignments([{
    file: 'uart.c',
    text: '#define UART_TX_PIN GPIO_PIN_6\n#define UART_TX_PORT GPIOB\nvoid f(void){GPIO_InitTypeDef s; s.Pin = UART_TX_PIN; s.Mode = GPIO_MODE_AF_PP; HAL_GPIO_Init(UART_TX_PORT, &s);}',
  }]);
  const tx = direct.find((pin) => pin.port === 'GPIOB' && pin.pin === 6);
  assert.ok(tx, 'macro HAL_GPIO_Init port resolved');
  assert.equal(tx.mode, 'GPIO_MODE_AF_PP');
});

test('install helpers pick the Windows asset and find binaries recursively', () => {
  const release = {
    tag_name: 'v14.3.1-1.1',
    assets: [
      { name: 'xpack-...-linux-x64.tar.gz', browser_download_url: 'https://x/linux', size: 10 },
      { name: 'xpack-...-win32-x64.zip', browser_download_url: 'https://x/win', size: 20 },
    ],
  };
  const asset = pickReleaseAsset(release, /win32-x64\.zip$/i);
  assert.equal(asset.url, 'https://x/win');
  assert.equal(asset.version, 'v14.3.1-1.1');
  assert.equal(pickReleaseAsset({ assets: [] }, /win32-x64\.zip$/i), null);

  const root = tempDir();
  mkdirSync(join(root, 'xpack', 'bin'), { recursive: true });
  writeFileSync(join(root, 'xpack', 'bin', 'arm-none-eabi-gcc.exe'), '');
  writeFileSync(join(root, 'xpack', 'bin', 'openocd.exe'), '');
  const found = findInstalledBinaries(root, ['arm-none-eabi-gcc.exe', 'openocd.exe']);
  assert.equal(found['arm-none-eabi-gcc.exe'], join(root, 'xpack', 'bin', 'arm-none-eabi-gcc.exe'));
  assert.equal(found['openocd.exe'], join(root, 'xpack', 'bin', 'openocd.exe'));
  assert.deepEqual(findInstalledBinaries(join(root, 'missing'), ['a.exe']), {});
});
test('Keil .uvprojx exports to a CMake/GCC tree', () => {
  const dir = tempDir();
  const srcDir = join(dir, 'Src');
  const rvdsDir = join(dir, 'portable', 'RVDS');
  const gccDir = join(dir, 'portable', 'GCC');
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(rvdsDir, { recursive: true });
  mkdirSync(gccDir, { recursive: true });
  writeFileSync(join(srcDir, 'main.c'), 'int main(void) { return 0; }\n');
  writeFileSync(join(dir, 'startup_stm32f407xx.s'), '; keil startup\n');
  writeFileSync(join(rvdsDir, 'port.c'), '/* armcc port */\n');
  writeFileSync(join(gccDir, 'port.c'), '/* gcc port */\n');
  const project = {
    path: join(dir, 'MDK-ARM', 'Demo.uvprojx'),
    dir: join(dir, 'MDK-ARM'),
    target: 'Demo',
    device: 'STM32F407VGTx',
    cpu: {
      core: 'Cortex-M4',
      fpu: 2,
      rom: [{ start: 0x08000000, size: 0x100000 }],
      ram: [{ start: 0x20000000, size: 0x20000 }],
    },
    output: { name: 'Demo' },
    compiler: { includes: [join(dir, 'Inc')], defines: ['USE_HAL_DRIVER'] },
    files: [
      { name: 'main.c', abs: join(srcDir, 'main.c') },
      { name: 'startup_stm32f407xx.s', abs: join(dir, 'startup_stm32f407xx.s') },
      { name: 'port.c', abs: join(rvdsDir, 'port.c') },
      { name: 'scatter.sct', abs: join(dir, 'scatter.sct') },
    ],
  };
  writeFileSync(join(dir, 'scatter.sct'), '; scatter\n');
  const result = exportKeilToCmake({ uvprojx: project }, { dir: join(dir, 'out') });
  assert.equal(result.sources, 2);
  assert.equal(result.includes, 1);
  assert.equal(result.defines, 1);
  assert.equal(result.remapped.length, 1);
  assert.ok(result.skipped.some((item) => item.name === 'startup_stm32f407xx.s'));
  assert.ok(result.skipped.some((item) => item.name === 'scatter.sct'));
  const cmake = readFileSync(join(result.dir, 'CMakeLists.txt'), 'utf8');
  assert.ok(cmake.indexOf('set(CMAKE_C_COMPILER') < cmake.indexOf('project(Demo'));
  assert.match(cmake, /cortex-m4 -mthumb -mfloat-abi=hard -mfpu=fpv4-sp-d16/);
  assert.match(cmake, /portable\/GCC\/port\.c/);
  assert.match(cmake, /-T\$\{CMAKE_CURRENT_SOURCE_DIR\}\/linker\.ld/);
  assert.match(cmake, /USE_HAL_DRIVER/);
  const linker = readFileSync(join(result.dir, 'linker.ld'), 'utf8');
  assert.match(linker, /ORIGIN = 0x8000000, LENGTH = 1024K/);
  assert.match(linker, /ORIGIN = 0x20000000, LENGTH = 128K/);
  assert.ok(existsSync(join(result.dir, 'startup_stm32.s')));
});

test('fs listing returns dirs and extension-filtered files', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'app.exe'), 'x');
  writeFileSync(join(dir, 'readme.txt'), 'x');

  const listing = listDirectory(dir, '.exe');
  assert.equal(listing.ok, true);
  assert.ok(listing.dirs.some((d) => d.name === 'sub'));
  assert.deepEqual(listing.files.map((f) => f.name), ['app.exe']);
  assert.equal(listing.files[0].path, join(dir, 'app.exe'));

  // Handing over a file path opens its directory and reports the selection.
  const selected = listDirectory(join(dir, 'app.exe'));
  assert.equal(selected.ok, true);
  assert.equal(selected.path, dir);
  assert.equal(selected.selected, join(dir, 'app.exe'));

  const roots = listDirectory('');
  assert.equal(roots.ok, true);
  assert.ok(roots.drives.length > 0);
});
