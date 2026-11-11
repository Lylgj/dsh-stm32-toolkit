import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFlashArgs } from '../src/engine/openocd.js';
import { SerialBridge, listSerialPorts } from '../src/engine/serial.js';

test('buildFlashArgs builds a program/verify/reset/exit command', () => {
  const args = buildFlashArgs({
    interfaceCfg: 'interface/stlink.cfg',
    targetCfg: 'target/stm32f4x.cfg',
    scriptsPath: 'C:/ocd/scripts',
    firmware: 'D:\\fw\\app.hex',
  });
  const line = args.join(' ');
  assert.match(line, /-s C:\/ocd\/scripts/);
  assert.match(line, /-f interface\/stlink\.cfg/);
  assert.match(line, /-f target\/stm32f4x\.cfg/);
  assert.match(line, /-c adapter speed 4000/);
  assert.match(line, /-c program "D:\/fw\/app\.hex" verify reset exit/);
  assert.doesNotMatch(line, /mass_erase/);
});

test('buildFlashArgs adds an address for .bin and a mass erase when asked', () => {
  const args = buildFlashArgs({
    interfaceCfg: 'interface/cmsis-dap.cfg',
    targetCfg: 'target/stm32f4x.cfg',
    firmware: 'D:/fw/app.bin',
    address: '0x08000000',
    erase: 'mass',
    adapterSpeed: 2000,
  });
  const line = args.join(' ');
  assert.match(line, /-c adapter speed 2000/);
  assert.match(line, /-c stm32f4x mass_erase/);
  assert.match(line, /-c program "D:\/fw\/app\.bin" 0x08000000 verify reset exit/);
});

test('buildFlashArgs can skip verify and reset', () => {
  const args = buildFlashArgs({
    interfaceCfg: 'interface/stlink.cfg',
    targetCfg: 'target/stm32f1x.cfg',
    firmware: 'D:/fw/app.elf',
    verify: false,
    reset: false,
  });
  const line = args.join(' ');
  assert.match(line, /-c program "D:\/fw\/app\.elf" exit/);
  assert.doesNotMatch(line, /verify/);
  assert.doesNotMatch(line, /reset exit/);
});

test('buildFlashArgs appends a log file when provided', () => {
  const args = buildFlashArgs({
    interfaceCfg: 'interface/stlink.cfg',
    targetCfg: 'target/stm32f4x.cfg',
    firmware: 'D:/fw/app.elf',
    logFile: 'D:/logs/flash.log',
  });
  const line = args.join(' ');
  assert.match(line, /-l D:\/logs\/flash\.log$/);
});

test('listSerialPorts returns an array of {port,label}', async () => {
  const ports = await listSerialPorts();
  assert.ok(Array.isArray(ports));
  for (const entry of ports) {
    assert.equal(typeof entry.port, 'string');
    assert.equal(typeof entry.label, 'string');
  }
});

test('SerialBridge rejects a port that does not exist', async () => {
  const bridge = new SerialBridge({ port: 'COM999', baud: 115200 });
  await assert.rejects(bridge.open(), /打开串口失败|串口进程退出|打开串口超时/);
  assert.equal(bridge.active, false);
});
