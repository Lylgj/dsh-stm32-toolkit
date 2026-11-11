import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseXml, childText, findAll, decodeEntities } from '../src/xml.js';
import { readUvprojx, parseCpuLine, openocdTargetForDevice, openocdInterfaceForDebugger } from '../src/engine/uvprojx.js';
import { parseSvd, findPeripheral, findRegister } from '../src/engine/svd.js';
import { MiParser, parseMiPayload, summarizeStop, unescapeCString } from '../src/engine/mi.js';
import { discoverProject, findArtifact, svdCandidatesForDevice, svdNameForDevice } from '../src/engine/project.js';
import { parseAddress, hex, bufferFromHex, hexFromBuffer } from '../src/util.js';

const KEIL_PROJECT = 'D:\\lgj\\mcu_acc_app\\MDK-ARM\\Project.uvprojx';

const SVD_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<device schemaVersion="1.1" xmlns:xs="http://www.w3.org/2001/XMLSchema-instance">
  <name>STM32TEST</name>
  <version>1.0</version>
  <description>fixture</description>
  <vendor>STMicroelectronics</vendor>
  <peripherals>
    <peripheral>
      <name>GPIOA</name>
      <description>General-purpose I/Os</description>
      <groupName>GPIO</groupName>
      <baseAddress>0x40020000</baseAddress>
      <registers>
        <register>
          <name>MODER</name>
          <description>GPIO port mode register</description>
          <addressOffset>0x0</addressOffset>
          <size>0x20</size>
          <access>read-write</access>
          <resetValue>0xA8000000</resetValue>
          <fields>
            <field>
              <name>MODER0</name>
              <description>Port x configuration bits (y = 0..15)</description>
              <bitOffset>0</bitOffset>
              <bitWidth>2</bitWidth>
              <access>read-write</access>
              <enumeratedValues>
                <enumeratedValue><name>Input</name><value>0</value></enumeratedValue>
                <enumeratedValue><name>Output</name><value>1</value></enumeratedValue>
                <enumeratedValue><name>Alternate</name><value>2</value></enumeratedValue>
                <enumeratedValue><name>Analog</name><value>3</value></enumeratedValue>
              </enumeratedValues>
            </field>
            <field>
              <name>MODER1</name><bitOffset>2</bitOffset><bitWidth>2</bitWidth>
              <enumeratedValues>
                <enumeratedValue><name>Input</name><value>0</value></enumeratedValue>
                <enumeratedValue><name>Output</name><value>1</value></enumeratedValue>
              </enumeratedValues>
            </field>
          </fields>
        </register>
        <register>
          <name>ODR</name>
          <description>Output data register</description>
          <addressOffset>0x14</addressOffset>
          <size>0x20</size>
          <access>read-write</access>
          <fields>
            <field>
              <name>ODR</name><bitOffset>0</bitOffset><bitWidth>16</bitWidth><access>read-write</access>
            </field>
          </fields>
        </register>
      </registers>
    </peripheral>
    <peripheral derivedFrom="GPIOA">
      <name>GPIOB</name>
      <baseAddress>0x40020400</baseAddress>
    </peripheral>
    <peripheral>
      <name>TIM2</name>
      <baseAddress>0x40000000</baseAddress>
      <registers>
        <register>
          <name>CCR%s</name>
          <dim>4</dim><dimIncrement>0x4</dimIncrement>
          <addressOffset>0x34</addressOffset>
          <fields>
            <field><name>CCR</name><bitOffset>0</bitOffset><bitWidth>16</bitWidth></field>
          </fields>
        </register>
      </registers>
    </peripheral>
  </peripherals>
</device>`;

test('xml parser handles attributes, entities and nesting', () => {
  const doc = parseXml('<root a="1"><item>x &amp; y</item><!-- c --><nested><v>2</v></nested></root>');
  assert.equal(doc.name, 'root');
  assert.equal(doc.attrs.a, '1');
  assert.equal(childText(doc, 'item'), 'x & y');
  assert.equal(findAll(doc, 'v').length, 1);
  assert.equal(decodeEntities('&lt;b&gt;'), '<b>');
});

test('SVD: peripherals, derivedFrom, dim expansion and enums', () => {
  const svd = parseSvd(SVD_FIXTURE);
  assert.equal(svd.name, 'STM32TEST');
  assert.equal(svd.peripherals.length, 3);

  const gpioa = findPeripheral(svd, 'GPIOA');
  assert.ok(gpioa);
  assert.equal(gpioa.baseAddress, 0x40020000);
  assert.equal(gpioa.groupName, 'GPIO');

  const moder = findRegister(gpioa, 'MODER');
  assert.ok(moder);
  assert.equal(moder.addressOffset, 0);
  assert.equal(moder.size, 32);
  assert.equal(moder.resetValue, 0xa8000000);
  assert.equal(moder.fields.length, 2);
  assert.equal(moder.fields[0].name, 'MODER0');
  assert.equal(moder.fields[0].bitOffset, 0);
  assert.equal(moder.fields[0].bitWidth, 2);
  assert.equal(moder.fields[0].enumeratedValues.length, 4);

  // derivedFrom copies registers but keeps its own base address
  const gpiob = findPeripheral(svd, 'GPIOB');
  assert.ok(gpiob);
  assert.equal(gpiob.baseAddress, 0x40020400);
  assert.ok(findRegister(gpiob, 'MODER'));

  // <dim> arrays expand CCR0..CCR3 with 4-byte stride
  const tim2 = findPeripheral(svd, 'TIM2');
  const ccrNames = tim2.registers.map((r) => r.name);
  assert.deepEqual(ccrNames, ['CCR0', 'CCR1', 'CCR2', 'CCR3']);
  assert.equal(tim2.registers[0].addressOffset, 0x34);
  assert.equal(tim2.registers[1].addressOffset, 0x38);
});

test('SVD lookup is case-insensitive', () => {
  const svd = parseSvd(SVD_FIXTURE);
  assert.equal(findPeripheral(svd, 'gpioa').name, 'GPIOA');
  assert.equal(findRegister(findPeripheral(svd, 'GPIOA'), 'moder').name, 'MODER');
});

test('cpu line parser understands Keil CPU strings', () => {
  const cpu = parseCpuLine('IROM(0x08000000,0x00100000) IRAM(0x20000000,0x00020000) CPUTYPE("Cortex-M4") FPU2 CLOCK(12000000) ELITTLE');
  assert.equal(cpu.core, 'Cortex-M4');
  assert.equal(cpu.fpu, 2);
  assert.equal(cpu.clock, 12000000);
  assert.equal(cpu.endian, 'little');
  assert.equal(cpu.rom[0].start, 0x08000000);
  assert.equal(cpu.rom[0].size, 0x00100000);
  assert.equal(cpu.ram[0].start, 0x20000000);
});

test('real Keil project parses (STM324xG_EVAL / STM32F407VGTx)', { skip: !existsSync(KEIL_PROJECT) }, () => {
  const info = readUvprojx(KEIL_PROJECT);
  assert.equal(info.target, 'STM324xG_EVAL');
  assert.equal(info.toolset, 'ARM-ADS');
  assert.equal(info.device, 'STM32F407VGTx');
  assert.equal(info.cpu.core, 'Cortex-M4');
  assert.equal(info.cpu.rom[0].start, 0x08000000);
  assert.equal(info.cpu.rom[0].size, 0x100000);
  assert.equal(info.cpu.ram[0].start, 0x20000000);
  assert.ok(info.compiler.defines.includes('STM32F407xx'));
  assert.ok(info.compiler.includes.length > 10);
  assert.ok(info.files.length > 50);
  assert.equal(info.output.name, 'STM324xG_EVAL');
  assert.ok(info.output.elf.endsWith('STM324xG_EVAL.axf'));
  assert.equal(openocdTargetForDevice(info.device), 'target/stm32f4x.cfg');
  assert.equal(info.debugger.recommendedInterface, 'interface/stlink.cfg');
});

test('OpenOCD mappings for common debuggers/families', () => {
  assert.equal(openocdTargetForDevice('STM32L476RGTx'), 'target/stm32l4x.cfg');
  assert.equal(openocdTargetForDevice('STM32H743ZITx'), 'target/stm32h7x.cfg');
  assert.equal(openocdTargetForDevice('STM32G071RBTx'), 'target/stm32g0x.cfg');
  assert.equal(openocdInterfaceForDebugger({ pMon: 'ST-Link' }), 'interface/stlink.cfg');
  assert.equal(openocdInterfaceForDebugger({ dlls: ['CMSIS_AGDI.DLL'] }), 'interface/cmsis-dap.cfg');
});

test('MI parser: stop event with frame tuple', () => {
  const parser = new MiParser();
  const records = parser.feed(
    '=thread-group-added,id="i1"\n' +
    '~"Reading symbols from demo.elf...\\n"\n' +
    '1^done,stack=[frame={level="0",addr="0x08000abc",func="main",file="main.c",line="42"},frame={level="1",addr="0x08000200",func="Reset_Handler"}]\n' +
    '*stopped,reason="breakpoint-hit",disp="keep",bkptno="1",frame={func="main",args=[],file="main.c",fullname="C:/demo/main.c",line="42",arch="arm"},thread-id="1",stopped-threads="all"\n' +
    '2^running\n' +
    '(gdb)',
  );

  const stop = records.find((r) => r.kind === 'exec' && r.class === 'stopped');
  assert.ok(stop, 'stopped record parsed');
  assert.equal(stop.data.reason, 'breakpoint-hit');
  assert.equal(stop.data.frame.func, 'main');
  assert.equal(stop.data.frame.line, '42');
  assert.equal(stop.data.frame.args.length, 0);
  assert.equal(stop.data['thread-id'], '1');

  const summary = summarizeStop(stop.data);
  assert.equal(summary.func, 'main');
  assert.equal(summary.file, 'main.c');
  assert.equal(summary.line, 42);
  assert.equal(summary.breakpointId, '1');

  const stack = records.find((r) => r.kind === 'result' && r.token === '1');
  assert.equal(stack.class, 'done');
  assert.equal(stack.data.stack.length, 2);
  assert.equal(stack.data.stack[0].frame.func, 'main');
  assert.equal(stack.data.stack[1].frame.level, '1');

  assert.ok(records.some((r) => r.kind === 'console' && r.text.startsWith('Reading symbols')));
  assert.ok(records.some((r) => r.kind === 'prompt'));
});

test('MI parser: errors, breakpoints and register values', () => {
  const { class: cls, data } = parseMiPayload('error,msg="No symbol \\"foo\\" in current context."');
  assert.equal(cls, 'error');
  assert.equal(data.msg, 'No symbol "foo" in current context.');

  const parser = new MiParser();
  const records = parser.feed(
    '5^done,bkpt={number="1",type="breakpoint",disp="keep",enabled="y",addr="0x08000abc",func="main",file="main.c",line="42",times="0",original-location="main"}\n' +
    '6^done,register-values=[{number="0",value="0x20000000"},{number="13",value="0x20000400"}]\n' +
    '7^done,register-names=["r0","r1","sp","lr","pc","xpsr"]\n',
  );
  const bkpt = records.find((r) => r.class === 'done' && r.data.bkpt);
  assert.equal(bkpt.data.bkpt.number, '1');
  assert.equal(bkpt.data.bkpt.times, '0');

  const regs = records.find((r) => r.data && r.data['register-values']);
  assert.equal(regs.data['register-values'][1].number, '13');
  assert.equal(regs.data['register-values'][1].value, '0x20000400');
});

test('MI string unescaping', () => {
  assert.equal(unescapeCString('a\\nb\\t\\"c\\"'), 'a\nb\t"c"');
  assert.equal(unescapeCString('\\101\\102'), 'AB');
});

test('address and hex helpers round-trip', () => {
  assert.equal(parseAddress('0x2000_0000'), 0x20000000);
  assert.equal(parseAddress('536870912'), 0x20000000);
  assert.equal(hex(0x40020000), '0x40020000');
  assert.equal(hex(0x1f, 2), '0x1F');
  const buf = bufferFromHex('DE AD BE EF');
  assert.equal(buf.length, 4);
  assert.equal(hexFromBuffer(buf), 'deadbeef');
});

test('SVD file name candidates prefer the exact part', () => {
  const candidates = svdCandidatesForDevice('STM32F407VGTx');
  assert.equal(candidates[0], 'STM32F407.svd');
  assert.ok(candidates.includes('STM32F40x.svd'));
  assert.equal(svdNameForDevice('STM32F407VGTx'), 'STM32F407.svd');
  assert.equal(svdCandidatesForDevice('').length, 0);
});

test('project discovery finds the Keil project', { skip: !existsSync('D:\\lgj\\mcu_acc_app') }, () => {
  const project = discoverProject('D:\\lgj\\mcu_acc_app');
  assert.ok(project);
  assert.equal(project.kind, 'uvprojx');
  assert.ok(project.file.endsWith('Project.uvprojx'));
});

test('artifact discovery returns a newest-first list', { skip: !existsSync('D:\\lgj\\mcu_acc_app\\MDK-ARM') }, () => {
  const found = findArtifact(resolve('D:\\lgj\\mcu_acc_app\\MDK-ARM'));
  assert.ok(Array.isArray(found));
  for (const item of found) {
    assert.ok(/\.(axf|elf|hex|bin)$/i.test(item.path));
    assert.ok(typeof item.mtime === 'number');
  }
});
