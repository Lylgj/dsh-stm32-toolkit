/**
 * Agent-facing tools (`stm32_*`).
 *
 * The panel and the tools drive the same service instance, so an agent can
 * build, flash, start a debug session and read registers while the human is
 * looking at the panel — they see the same state.
 */

import { hex } from './util.js';

const text = (value) => [{ type: 'text', text: value }];

function ok(value) {
  return { ok: true, ...value };
}

function failure(error) {
  return { ok: false, error: String(error?.message ?? error) };
}

function formatArtifacts(artifacts = []) {
  return artifacts.map((a) => `  ${a.ext.toUpperCase().padEnd(5)} ${a.path} (${Math.round(a.size / 1024)} KB)`).join('\n');
}

function formatErrors(errors = [], limit = 30) {
  if (errors.length === 0) return '';
  return errors.slice(0, limit).map((e) => {
    const where = [e.file, e.line ? `:${e.line}` : ''].join('');
    return `  ${where ? `${where} ` : ''}${e.message}`;
  }).join('\n');
}

/** Register all tools with a given defineTool implementation. */
export function registerTools(ctx, service, defineTool) {
  const register = (tool) => ctx.tools.register(tool);

  register(defineTool({
    name: 'stm32_project',
    description: '查看或切换当前 STM32 工程：自动识别 Keil .uvprojx / CMake / Makefile，读取芯片型号、构建产物和 SVD 寄存器文件。',
    parameters: {
      dir: { type: 'string', description: '工程目录（绝对路径或相对当前工作目录）。省略则使用已配置工程。' },
      action: { type: 'string', enum: ['inspect', 'set'], description: 'inspect=只查看；set=切换当前工程。默认 inspect。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text(renderProject(value)) },
    timeoutMs: 60_000,
    async execute(args) {
      try {
        if (args.action === 'set' && args.dir) service.config.projectDir = args.dir;
        const info = await service.inspect(args.dir || service.config.projectDir, true);
        return ok({ project: sanitizeProject(info) });
      } catch (error) {
        return failure(error);
      }
    },
  }));

  register(defineTool({
    name: 'stm32_doctor',
    description: '检查 STM32 开发环境：Keil UV4、arm-none-eabi-gcc/gdb、OpenOCD、SEGGER J-Link、STM32CubeProgrammer、已连接的调试器（ST-Link/CMSIS-DAP/J-Link）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text(renderDoctor(value)) },
    timeoutMs: 60_000,
    async execute() {
      try {
        const tc = await service.getToolchain(true);
        return ok({ toolchain: tc });
      } catch (error) {
        return failure(error);
      }
    },
  }));

  register(defineTool({
    name: 'stm32_config',
    description: '读取或修改插件配置（工具链路径、调试器类型/后端、OpenOCD/J-Link 端口与速度、芯片/SVD 等），写入 %DSH_HOME%/stm32/config.json。',
    parameters: {
      patch: { type: 'json', description: '要写入的配置片段，例如 {"probe":"cmsis-dap","adapterSpeed":2000}。省略则只读取当前配置。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text(`当前配置:\n${JSON.stringify(value.config ?? value, null, 2)}`) },
    timeoutMs: 30_000,
    async execute(args) {
      try {
        const config = args.patch && typeof args.patch === 'object'
          ? service.saveConfig(args.patch)
          : service.config;
        return ok({ config });
      } catch (error) {
        return failure(error);
      }
    },
  }));

  register(defineTool({
    name: 'stm32_build',
    description: '编译当前 STM32 工程。Keil 工程优先调用 UV4 命令行构建；没装 Keil 时自动把 .uvprojx 导出为 CMake 并用 arm-none-eabi-gcc 编译。CMake/Makefile 工程直接调用 cmake/make。返回错误、警告和生成的固件。',
    parameters: {
      clean: { type: 'boolean', description: '是否先执行清理（Keil -c / make clean）。' },
      target: { type: 'string', description: 'Keil 目标名（多目标工程时使用）。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text(renderBuild(value)) },
    timeoutMs: 25 * 60 * 1000,
    async execute(args) {
      try {
        const result = await service.build({ clean: Boolean(args.clean), target: args.target });
        return ok({ build: result });
      } catch (error) {
        return failure(error);
      }
    },
  }));

  register(defineTool({
    name: 'stm32_export',
    description: '把 Keil .uvprojx 工程导出成 CMake/GCC 工程：复制源文件列表、include 和宏定义，用 GNU 启动文件替换 Keil 汇编启动文件，并按芯片存储区生成 linker.ld。没有 Keil MDK 也能用 arm-none-eabi 编译。',
    parameters: {
      projectDir: { type: 'string', description: 'Keil 工程目录，省略则使用当前工程。' },
      outputDir: { type: 'string', description: '导出目录，默认 <工程目录>/.dsh-gcc。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text(renderExport(value)) },
    timeoutMs: 120_000,
    async execute(args) {
      try {
        const result = await service.exportCmake({ projectDir: args.projectDir, outputDir: args.outputDir });
        return ok({ export: result });
      } catch (error) {
        return failure(error);
      }
    },
  }));

  register(defineTool({
    name: 'stm32_flash',
    description: '把固件下载到芯片（按 backend 选择 SEGGER J-Link 或 OpenOCD；都不可用时回退到 Keil UV4 -f）。可整片擦除、校验、下载后复位。',
    parameters: {
      artifact: { type: 'string', description: '要下载的 .elf/.hex/.bin 路径。省略则使用工程最近构建产物。' },
      address: { type: 'string', description: '仅 .bin 需要，下载地址，例如 0x08000000。' },
      erase: { type: 'string', enum: ['none', 'mass'], description: '擦除方式：none=按扇区擦除（默认），mass=整片擦除（会丢失整颗芯片数据）。' },
      verify: { type: 'boolean', description: '下载后是否校验，默认 true。' },
      reset: { type: 'boolean', description: '下载后是否复位运行，默认 true。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text(renderFlash(value)) },
    timeoutMs: 5 * 60 * 1000,
    async execute(args) {
      try {
        const result = await service.flash({
          artifact: args.artifact,
          address: args.address,
          erase: args.erase,
          verify: args.verify,
          reset: args.reset,
        });
        return ok({ flash: result });
      } catch (error) {
        return failure(error);
      }
    },
  }));

  register(defineTool({
    name: 'stm32_debug',
    description: '控制 SWD 调试会话：start/stop/continue/pause/单步/复位/状态。start 会启动调试后端（SEGGER J-Link GDB Server 或 OpenOCD）与 GDB、加载 ELF、复位并运行到 main。',
    parameters: {
      action: { type: 'string', enum: ['start', 'stop', 'continue', 'pause', 'stepInto', 'stepOver', 'stepOut', 'stepInstruction', 'reset', 'resetRun', 'status'], description: '调试动作。' },
      elf: { type: 'string', description: 'start 时可指定 ELF/AXF 路径。' },
      waitMs: { type: 'number', description: 'continue 后等待暂停的毫秒数，0=立即返回。' },
      runToMain: { type: 'boolean', description: 'start 时是否运行到 main（默认 true）。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text(renderDebug(value)) },
    timeoutMs: 3 * 60 * 1000,
    async execute(args) {
      try {
        const action = args.action ?? 'status';
        if (action === 'start') {
          const state = await service.debugStart({ elf: args.elf, runToMain: args.runToMain });
          return ok({ state });
        }
        if (action === 'stop') return ok({ state: await service.debugStop() });
        if (action === 'status') return ok({ state: service.debug.state() });
        const result = await service.debugAction(action, { waitMs: args.waitMs ?? 0 });
        return ok({ result, state: service.debug.state() });
      } catch (error) {
        return failure(error);
      }
    },
  }));

  register(defineTool({
    name: 'stm32_breakpoint',
    description: '管理断点：执行断点（函数名、文件:行号、地址）与数据监视点（变量/地址的读、写、读写），支持删除、列出。',
    parameters: {
      action: { type: 'string', enum: ['add', 'remove', 'list'], description: '操作。' },
      kind: { type: 'string', enum: ['code', 'watch', 'readwatch', 'accesswatch'], description: '断点类型：code=执行断点（默认），watch=写监视，readwatch=读监视，accesswatch=读写监视。' },
      location: { type: 'string', description: 'add 时的位置：执行断点用 main、src/main.c:42、0x08000A2C；监视点用变量名或地址，例如 counter、*(int*)0x20000000。' },
      expression: { type: 'string', description: '监视点表达式（kind=watch 时使用，省略则用 location）。' },
      id: { type: 'number', description: 'remove 时的断点编号。' },
      condition: { type: 'string', description: '条件表达式，例如 count==10。' },
      hardware: { type: 'boolean', description: '是否使用硬件断点。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text(renderBreakpoints(value)) },
    timeoutMs: 60_000,
    async execute(args) {
      try {
        if (args.action === 'list' || (!args.action && !args.location)) {
          return ok({ breakpoints: await service.debug.listBreakpoints() });
        }
        if (args.action === 'remove') return ok({ breakpoints: (await service.debug.removeBreakpoint(args.id)).breakpoints });
        if (args.kind === 'watch' || args.kind === 'readwatch' || args.kind === 'accesswatch') {
          const watchpoint = await service.debug.setWatchpoint(args.expression || args.location, {
            read: args.kind === 'readwatch',
            access: args.kind === 'accesswatch',
          });
          return ok({ breakpoint: watchpoint, breakpoints: service.debug.breakpoints });
        }
        const breakpoint = await service.debug.setBreakpoint(args.location, {
          condition: args.condition,
          hardware: args.hardware,
        });
        return ok({ breakpoint, breakpoints: service.debug.breakpoints });
      } catch (error) {
        return failure(error);
      }
    },
  }));

  register(defineTool({
    name: 'stm32_registers',
    description: '读取寄存器：core=Cortex-M 内核寄存器；peripheral=某个外设的全部寄存器（SVD 位域解码）；list=列出 SVD 外设；register=单个寄存器。',
    parameters: {
      kind: { type: 'string', enum: ['core', 'peripheral', 'list', 'register'], description: '读取类型。默认 core。' },
      name: { type: 'string', description: 'peripheral/register 时的名字，例如 GPIOA 或 GPIOA.MODER。' },
      json: { type: 'boolean', description: 'true 时返回原始数据而不是格式化文本。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text(renderRegisters(args, value)) },
    timeoutMs: 60_000,
    async execute(args) {
      try {
        const kind = args.kind ?? 'core';
        if (kind === 'list') {
          const svd = service.svd();
          if (!svd) throw new Error('没有可用的 SVD 文件');
          return ok({ peripherals: svd.peripherals.map((p) => ({ name: p.name, baseAddress: hex(p.baseAddress), registers: p.registers.length, description: p.description })) });
        }
        if (kind === 'core') return ok({ core: await service.debug.registers() });
        if (kind === 'peripheral') return ok({ peripheral: await service.debug.peripheral(args.name) });
        if (kind === 'register') return ok({ register: await service.debug.register(args.name) });
        throw new Error(`未知 kind: ${kind}`);
      } catch (error) {
        return failure(error);
      }
    },
  }));

  register(defineTool({
    name: 'stm32_memory',
    description: '读写目标内存（调试会话必须已启动）：read 读取十六进制字节；write 写入十六进制字节串。',
    parameters: {
      action: { type: 'string', enum: ['read', 'write'], description: '操作。默认 read。' },
      address: { type: 'string', description: '起始地址，例如 0x20000000。', required: true },
      count: { type: 'number', description: 'read 时读取字节数，默认 64。' },
      data: { type: 'string', description: 'write 时的十六进制字节串，例如 "01 02 0A FF"。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text(renderMemory(args, value)) },
    timeoutMs: 60_000,
    async execute(args) {
      try {
        if (args.action === 'write') return ok({ write: await service.debug.writeMemory(args.address, args.data) });
        return ok({ memory: await service.debug.readMemory(args.address, args.count ?? 64) });
      } catch (error) {
        return failure(error);
      }
    },
  }));

  register(defineTool({
    name: 'stm32_stack',
    description: '读取调用栈和当前栈帧的局部变量/参数。',
    parameters: {
      depth: { type: 'number', description: '最多返回多少层，默认 24。' },
      locals: { type: 'boolean', description: '是否同时读取局部变量，默认 true。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text(renderStack(value)) },
    timeoutMs: 60_000,
    async execute(args) {
      try {
        const frames = await service.debug.stack(args.depth ?? 24);
        const variables = args.locals === false ? [] : await service.debug.locals().catch(() => []);
        return ok({ frames, variables });
      } catch (error) {
        return failure(error);
      }
    },
  }));

  register(defineTool({
    name: 'stm32_watch',
    description: '在调试会话中求值表达式 / 查看变量，例如 count、&buf、GPIOA->ODR、*(uint32_t*)0x40020014。',
    parameters: {
      expression: { type: 'string', description: 'C 表达式或变量名。', required: true },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text(args.expression ? `${args.expression} = ${value.result?.value ?? ''}` : renderJson(value)) },
    timeoutMs: 60_000,
    async execute(args) {
      try {
        return ok({ result: await service.debug.evaluate(args.expression) });
      } catch (error) {
        return failure(error);
      }
    },
  }));

  register(defineTool({
    name: 'stm32_disasm',
    description: '反汇编目标代码（调试会话已启动），默认从当前 PC 开始。',
    parameters: {
      address: { type: 'string', description: '起始地址，省略则用当前 PC。' },
      count: { type: 'number', description: '指令条数，默认 16。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text((value.instructions ?? []).map((i) => `${i.address}  ${i.instruction}`).join('\n') || renderJson(value)) },
    timeoutMs: 60_000,
    async execute(args) {
      try {
        return ok({ instructions: await service.debug.disassemble(args.address, args.count ?? 16) });
      } catch (error) {
        return failure(error);
      }
    },
  }));

  register(defineTool({
    name: 'stm32_serial',
    description: '串口监视器：列出串口、打开/关闭串口、发送文本或十六进制数据、读取最近收到的数据（调试会话之外可用）。',
    parameters: {
      action: { type: 'string', enum: ['ports', 'open', 'close', 'write', 'read', 'clear'], description: '操作。默认 read。' },
      port: { type: 'string', description: 'open 时的串口名，例如 COM3。省略则使用配置中的 serialPort。' },
      baud: { type: 'number', description: '波特率，默认 115200。' },
      data: { type: 'string', description: 'write 时要发送的文本；hex=true 时为十六进制串，例如 "01 0A FF"。' },
      hex: { type: 'boolean', description: 'write 时按十六进制发送。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text(renderSerial(value)) },
    timeoutMs: 60_000,
    async execute(args) {
      try {
        const action = args.action ?? 'read';
        if (action === 'ports') return ok({ ports: await service.serialPorts() });
        if (action === 'open') return ok({ serial: await service.serialOpen({ port: args.port, baud: args.baud }) });
        if (action === 'close') return ok({ serial: await service.serialClose() });
        if (action === 'write') return ok({ write: service.serialWrite(args.data ?? '', { hex: Boolean(args.hex) }) });
        if (action === 'clear') return ok({ serial: service.serialClear() });
        return ok({ serial: service.serialState() });
      } catch (error) {
        return failure(error);
      }
    },
  }));

  register(defineTool({
    name: 'stm32_env',
    description: 'STM32 工具链环境：查看 Keil/GCC/OpenOCD/调试器状态，或一键下载安装 xPack arm-none-eabi-gcc 与 OpenOCD 到 DSH 数据目录。',
    parameters: {
      action: { type: 'string', enum: ['status', 'install'], description: 'status=检查环境；install=下载安装。默认 status。' },
      components: { type: 'string', description: 'install 时安装的组件：gcc / openocd / all，默认 all。' },
      force: { type: 'boolean', description: 'install 时重新下载安装（即使已存在）。' },
      url: { type: 'string', description: 'install 时直接指定 zip 下载地址（离线/镜像场景）。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text(renderEnv(value)) },
    timeoutMs: 45 * 60 * 1000,
    async execute(args) {
      try {
        const action = args.action ?? 'status';
        if (action === 'install') {
          const components = args.components && args.components !== 'all'
            ? String(args.components).split(',').map((item) => item.trim())
            : ['gcc', 'openocd'];
          const toolchain = await service.getToolchain(true);
          const result = await service.envInstall({ components, force: Boolean(args.force), url: args.url });
          return ok({ install: result, toolchain });
        }
        return ok({ toolchain: await service.getToolchain(true), cores: service.cores() });
      } catch (error) {
        return failure(error);
      }
    },
  }));

  register(defineTool({
    name: 'stm32_symbols',
    description: '解析符号表（Keil/GNU .map 或 ELF）：按名字查找符号、按地址找所在函数、列出符号表来源。',
    parameters: {
      action: { type: 'string', enum: ['find', 'at', 'info'], description: 'find=按名字查找；at=按地址找符号；info=符号表来源。默认 find。' },
      query: { type: 'string', description: 'find 时的名字（精确或子串）。' },
      address: { type: 'string', description: 'at 时的地址，例如 0x08000c4d。' },
      limit: { type: 'number', description: '最多返回条数，默认 30。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text(renderSymbols(value)) },
    timeoutMs: 60_000,
    async execute(args) {
      try {
        const action = args.action ?? 'find';
        if (action === 'info') {
          const loaded = await service.symbols(true);
          if (!loaded) return ok({ found: false });
          return ok({ found: true, file: loaded.file, source: loaded.source, count: loaded.symbols.length });
        }
        if (action === 'at') return ok(await service.symbolAt(args.address ?? '0'));
        const found = await service.symbolFind(args.query ?? '');
        if (found.ok) found.symbols = found.symbols.slice(0, args.limit ?? 30);
        return ok({ ...found, symbols: found.symbols ?? [] });
      } catch (error) {
        return failure(error);
      }
    },
  }));

  register(defineTool({
    name: 'stm32_pins',
    description: '静态引脚图：扫描工程 C 源码里的 HAL_GPIO_Init 与 HAL_GPIO_WritePin 调用，并结合 .ioc 的引脚信号，列出每个 GPIO 引脚的用途。',
    parameters: {
      port: { type: 'string', description: '只显示某个端口，例如 GPIOA。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text(renderPins(value)) },
    timeoutMs: 120_000,
    async execute(args) {
      try {
        const map = service.pins();
        if (args.port) {
          const wanted = String(args.port).toUpperCase();
          map.pins = map.pins.filter((pin) => pin.port === wanted);
        }
        return ok(map);
      } catch (error) {
        return failure(error);
      }
    },
  }));

  register(defineTool({
    name: 'stm32_ioc',
    description: 'CubeMX .ioc 文件：读取摘要（芯片、封装、引脚信号、外设），修改单个配置项，或新建一个最小 CMake 工程（含 .ioc、启动文件、链接脚本与寄存器级 main.c）。',
    parameters: {
      action: { type: 'string', enum: ['inspect', 'set', 'create'], description: 'inspect=读取；set=写回配置项；create=新建工程骨架。默认 inspect。' },
      patch: { type: 'json', description: 'set 时的键值对，例如 {"Mcu.Pin0.Signal":"GPIO_Output"}。' },
      dir: { type: 'string', description: 'create 时的目标目录。' },
      device: { type: 'string', description: 'create 时的芯片型号，默认 STM32F407VGTx。' },
      name: { type: 'string', description: 'create 时的工程名。' },
      ledPin: { type: 'string', description: 'create 时闪烁的 LED 引脚，默认 PA5。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text(renderIoc(value)) },
    timeoutMs: 60_000,
    async execute(args) {
      try {
        const action = args.action ?? 'inspect';
        if (action === 'create') {
          return ok(service.createProject({
            dir: args.dir,
            device: args.device,
            name: args.name,
            ledPin: args.ledPin,
          }));
        }
        if (action === 'set') {
          const patch = typeof args.patch === 'string' ? JSON.parse(args.patch) : (args.patch ?? {});
          return ok(service.iocSet(patch));
        }
        return ok(service.iocInfo());
      } catch (error) {
        return failure(error);
      }
    },
  }));

  register(defineTool({
    name: 'stm32_rtt',
    description: 'SEGGER RTT 日志（需先启动调试会话）：通过 OpenOCD 打开 RTT 通道，读取目标 printf 日志，或向通道写数据。',
    parameters: {
      action: { type: 'string', enum: ['start', 'stop', 'state', 'write', 'clear'], description: '操作。默认 state。' },
      address: { type: 'string', description: 'start 时 _SEGGER_RTT 控制块地址；省略则用 GDB 符号，找不到就在内存范围搜索。' },
      text: { type: 'string', description: 'write 时要写入通道的内容。' },
      channel: { type: 'number', description: 'RTT 通道号，默认 0。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => text(renderRtt(value)) },
    timeoutMs: 60_000,
    async execute(args) {
      try {
        const action = args.action ?? 'state';
        if (action === 'start') return ok({ rtt: await service.rttStart({ address: args.address, channel: args.channel }) });
        if (action === 'stop') return ok({ rtt: await service.rttStop() });
        if (action === 'write') return ok({ write: service.rttWrite(args.text ?? '') });
        if (action === 'clear') return ok({ rtt: service.rttClear() });
        return ok({ rtt: service.rttState() });
      } catch (error) {
        return failure(error);
      }
    },
  }));
}

function renderEnv(value) {
  if (!value.ok) return `环境操作失败: ${value.error}`;
  if (value.install) {
    const lines = ['工具链安装完成:'];
    for (const result of value.install.results ?? []) {
      lines.push(`  ${result.component}: ${result.dir}`);
      for (const [name, path] of Object.entries(result.binaries ?? {})) lines.push(`    ${name} -> ${path}`);
      if (result.scripts) lines.push(`    scripts -> ${result.scripts}`);
    }
    return lines.join('\n');
  }
  const toolchain = value.toolchain ?? {};
  const lines = [
    `Keil UV4: ${toolchain.keil?.installed ? toolchain.keil.uv4 : '未安装'}`,
    `arm-none-eabi-gcc: ${toolchain.gcc?.installed ? `${toolchain.gcc.version} ${toolchain.gcc.gcc}` : '未安装'}`,
    `arm-none-eabi-gdb: ${toolchain.gcc?.gdb ?? '未安装'}`,
    `OpenOCD: ${toolchain.openocd?.installed ? `${toolchain.openocd.version} ${toolchain.openocd.path}` : '未安装'}`,
    `调试器: ${(toolchain.probes?.probes ?? []).map((p) => p.name).join(', ') || '未连接'}`,
  ];
  if (value.cores?.cores > 1) lines.push(`内核: ${value.cores.cores} 个（当前 core${value.cores.selected}）`);
  return lines.join('\n');
}

function renderSymbols(value) {
  if (!value.ok) return `符号操作失败: ${value.error}`;
  if (value.symbols) {
    if (value.symbols.length === 0) return `没有匹配的符号（来源: ${value.source ?? '未知'}）。`;
    return value.symbols.map((s) => `${s.name.padEnd(32)} ${`0x${Number(s.address).toString(16).padStart(8, '0')}`}  ${s.size ? `${s.size}B ` : ''}${s.type}`).join('\n');
  }
  if (value.symbol) {
    const s = value.symbol;
    return `${value.address}  ${s.name} + 0x${s.offset.toString(16)}${s.size ? ` (${s.size}B)` : ''}${s.object ? `  ${s.object}` : ''}`;
  }
  return value.found ? `符号表: ${value.file}（${value.source}，${value.count} 个符号）` : '未找到符号表（构建后生成 .map 或 .elf）';
}

function renderPins(value) {
  if (!value.ok) return `引脚解析失败: ${value.error}`;
  const pins = value.pins ?? [];
  if (!pins.length) return '没有在源码/.ioc 中解析到引脚配置。';
  return pins.map((pin) => {
    const name = `${pin.port}${pin.pin}`.padEnd(7);
    return `${name} ${(pin.mode || '-').padEnd(20)} ${(pin.label || '').padEnd(12)} ${pin.source?.split(/[\\/]/).pop() ?? ''}`;
  }).join('\n');
}

function renderIoc(value) {
  if (!value.ok) return `.ioc 操作失败: ${value.error}`;
  if (value.files) {
    return [`已创建工程: ${value.dir}`, `芯片: ${value.device}  Flash ${value.memory.flashKb}KB / RAM ${value.memory.ramKb}KB`, '', ...value.files.map((f) => `  ${f}`)].join('\n');
  }
  const lines = [`${value.mcu?.name ?? '?'} (${value.mcu?.package ?? '?'})  ${value.file ?? ''}`, `引脚 ${value.pins?.length ?? 0} 个, 外设: ${(value.peripherals ?? []).join(', ') || '-'}`];
  for (const pin of value.pins ?? []) lines.push(`  ${pin.pin.padEnd(6)} ${(pin.signal || '').padEnd(20)} ${pin.label ?? ''}`);
  return lines.join('\n');
}

function renderRtt(value) {
  if (!value.ok) return `RTT 操作失败: ${value.error}`;
  if (value.write) return `已写入 RTT ${value.write.bytes} 字节`;
  const rtt = value.rtt ?? {};
  const lines = [`RTT: ${rtt.active ? `已连接 端口 ${rtt.port} 通道 ${rtt.channel}` : '未启动'}  收到 ${rtt.bytes ?? 0} 字节`];
  for (const line of (rtt.lines ?? []).slice(-120)) lines.push(`  ${line}`);
  return lines.join('\n');
}

function sanitizeProject(info) {
  return {
    root: info.root,
    kind: info.project?.kind ?? '',
    file: info.project?.file ?? '',
    device: info.device,
    pack: info.pack,
    target: info.uvprojx?.target ?? '',
    targets: info.uvprojx?.targets ?? [],
    backend: info.backend ?? '',
    artifact: info.artifact,
    artifacts: (info.artifacts ?? []).slice(0, 8).map((a) => ({ path: a.path, ext: a.ext, size: a.size })),
    svd: info.svd,
    cpu: info.uvprojx?.cpu ?? null,
    errors: info.errors ?? [],
  };
}

function renderJson(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function renderProject(value) {
  if (!value.ok) return `失败: ${value.error}`;
  const p = value.project;
  const lines = [
    `工程根目录: ${p.root}`,
    `类型: ${p.kind || '未识别'}  文件: ${p.file || '-'}`,
    `芯片: ${p.device || '未知'}${p.pack ? `  (Pack: ${p.pack})` : ''}`,
    `构建后端: ${p.backend || '-'}`,
  ];
  if (p.target) lines.push(`Keil 目标: ${p.target}${p.targets?.length > 1 ? `（共 ${p.targets.length} 个: ${p.targets.join(', ')}）` : ''}`);
  if (p.svd?.path) lines.push(`SVD: ${p.svd.path} (${p.svd.source})`);
  if (p.artifact) lines.push(`最新固件: ${p.artifact}`);
  if (p.artifacts?.length) lines.push(`可用产物:\n${p.artifacts.map((a) => `  ${a.path}`).join('\n')}`);
  if (p.errors?.length) lines.push(`问题: ${p.errors.join('; ')}`);
  return lines.join('\n');
}

function renderDoctor(value) {
  if (!value.ok) return `失败: ${value.error}`;
  const tc = value.toolchain;
  const mark = (okFlag) => (okFlag ? 'OK  ' : '缺失');
  const jl = tc.jlink ?? {};
  return [
    `Keil MDK: ${mark(tc.keil?.installed)} ${tc.keil?.uv4 ?? ''}`,
    `arm-none-eabi-gcc: ${mark(tc.gcc?.installed)} ${tc.gcc?.version ?? ''}`,
    `arm-none-eabi-gdb: ${mark(Boolean(tc.gcc?.gdb))} ${tc.gcc?.gdb ?? ''}`,
    `OpenOCD: ${mark(tc.openocd?.installed)} ${tc.openocd?.path ?? ''} ${tc.openocd?.version ?? ''}`,
    `SEGGER J-Link: ${mark(jl.installed)} ${jl.version ?? ''} ${jl.dir ?? ''}`,
    `STM32CubeProgrammer: ${tc.programmers?.cubeProgrammer ?? '未安装'}`,
    `pyOCD: ${tc.programmers?.pyocd ?? '未安装'}`,
    `已连接调试器: ${tc.probes?.probes?.length ? tc.probes.probes.join(', ') : '未检测到'}`,
    `可用后端: ${tc.backend || '无'}`,
    tc.ready
      ? '环境就绪，可以编译/调试。'
      : '环境不完整：至少需要 Keil UV4，或 arm-none-eabi-gcc + gdb + (OpenOCD 或 SEGGER J-Link)。',
  ].join('\n');
}

function renderBuild(value) {
  if (!value.ok) return `构建请求失败: ${value.error}`;
  const b = value.build;
  const lines = [
    `构建${b.ok ? '成功' : '失败'}（后端 ${b.backend}${b.codeText ? `, ${b.codeText}` : ''}, ${(b.durationMs / 1000).toFixed(1)}s）`,
  ];
  if (b.errors?.length) lines.push(`错误 (${b.errors.length}):\n${formatErrors(b.errors)}`);
  if (b.warnings?.length) lines.push(`警告: ${b.warnings.length} 个`);
  if (b.artifacts?.length) lines.push(`产物:\n${formatArtifacts(b.artifacts)}`);
  if (!b.ok && b.log) lines.push(`--- 日志尾部 ---\n${String(b.log).split(/\r?\n/).slice(-25).join('\n')}`);
  return lines.join('\n');
}

function renderExport(value) {
  if (!value.ok) return `导出失败: ${value.error}`;
  const e = value.export;
  const lines = [
    `已导出 CMake 工程: ${e.dir}`,
    `源文件 ${e.sources} 个，include ${e.includes} 个，宏定义 ${e.defines} 个`,
    `生成文件: ${e.files.map((f) => f.split(/[\\/]/).pop()).join(', ')}`,
  ];
  if (e.skipped?.length) lines.push(`跳过 ${e.skipped.length} 个:\n${e.skipped.map((s) => `- ${s.name}: ${s.reason}`).join('\n')}`);
  if (e.remapped?.length) lines.push(`换用 GCC 版本 ${e.remapped.length} 个`);
  lines.push(`编译: cmake -S "${e.dir}" -B "${e.buildDir}" -G Ninja && cmake --build "${e.buildDir}"`);
  return lines.join('\n');
}

function renderFlash(value) {
  if (!value.ok) return `下载请求失败: ${value.error}`;
  const f = value.flash;
  return [
    `下载${f.ok ? '成功' : '失败'}（${f.backend}，${(f.durationMs / 1000).toFixed(1)}s）`,
    f.artifact ? `固件: ${f.artifact}` : '',
    !f.ok && f.output ? `--- 输出 ---\n${String(f.output).slice(-1500)}` : '',
  ].filter(Boolean).join('\n');
}

function formatStop(stop) {
  if (!stop) return '';
  const location = [stop.file, stop.line ? `:${stop.line}` : ''].join('');
  return `${stop.reason || 'stopped'}${stop.func ? ` @ ${stop.func}` : ''}${location ? ` (${location})` : ''}`;
}

function renderDebug(value) {
  if (!value.ok) return `调试操作失败: ${value.error}`;
  const state = value.state ?? value.result?.state;
  const lines = [`调试: ${state?.active ? (state.running ? '运行中' : '已暂停') : '未启动'}`];
  if (state?.stop) lines.push(`位置: ${formatStop(state.stop)}`);
  if (value.result) lines.push(renderJson(value.result));
  if (value.state && !state?.active) lines.push('使用 stm32_debug action=start 启动会话。');
  return lines.join('\n');
}

function renderBreakpoints(value) {
  if (!value.ok) return `断点操作失败: ${value.error}`;
  if (value.breakpoint) return `已添加断点 #${value.breakpoint.number} ${value.breakpoint.func || ''} ${value.breakpoint.file}:${value.breakpoint.line}`;
  const list = value.breakpoints ?? [];
  if (list.length === 0) return '当前没有断点。';
  return list.map((b) => `#${b.number}  ${b.enabled === 'y' ? '启用' : '禁用'}  ${b.func || b.address}  ${b.file}${b.line ? `:${b.line}` : ''}  ${b.type}`).join('\n');
}

function renderRegisters(args, value) {
  if (!value.ok) return `读取寄存器失败: ${value.error}`;
  if (value.core) {
    return value.core.registers.map((r) => `${r.name.padEnd(8)} ${r.value}${r.description ? `   ${r.description}` : ''}`).join('\n');
  }
  if (value.peripherals) {
    return value.peripherals.map((p) => `${p.name.padEnd(12)} ${p.baseAddress}  ${p.registers} 个寄存器  ${p.description ?? ''}`).join('\n');
  }
  if (value.peripheral) {
    const p = value.peripheral;
    const lines = [`${p.peripheral} @ ${p.baseAddress}`];
    for (const r of p.registers) {
      lines.push(`${r.name.padEnd(12)} ${r.value}  ${r.access ?? ''}  ${r.description ?? ''}`);
      for (const f of r.fields) {
        lines.push(`    ${f.name.padEnd(12)} bits[${f.bitOffset + f.bitWidth - 1}:${f.bitOffset}] = ${f.hex}${f.meaning ? ` (${f.meaning})` : ''}`);
      }
    }
    return lines.join('\n');
  }
  if (value.register) {
    const r = value.register;
    return [`${r.name ?? ''} @ ${r.address} = ${r.value}`, ...(r.fields ?? []).map((f) => `  ${f.name} = ${f.hex}${f.meaning ? ` (${f.meaning})` : ''}`)].join('\n');
  }
  return renderJson(value);
}

function renderMemory(args, value) {
  if (!value.ok) return `内存操作失败: ${value.error}`;
  if (value.write) return `已写入 ${value.write.bytes} 字节 @ ${value.write.address}`;
  const m = value.memory;
  const rows = [];
  for (let i = 0; i < m.bytes.length; i += 16) {
    const chunk = m.bytes.slice(i, i + 16);
    const addr = (Number.parseInt(m.address, 16) + i).toString(16).toUpperCase().padStart(8, '0');
    const hexPart = chunk.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    const ascii = chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    rows.push(`${addr}  ${hexPart.padEnd(47)}  ${ascii}`);
  }
  return rows.join('\n') || '(空)';
}

function renderSerial(value) {
  if (!value.ok) return `串口操作失败: ${value.error}`;
  if (value.ports) {
    return value.ports.length === 0
      ? '没有检测到串口。'
      : value.ports.map((p) => `${p.port}  ${p.label ?? ''}`).join('\n');
  }
  if (value.write) return `已发送 ${value.write.bytes} 字节。`;
  const s = value.serial ?? {};
  const lines = [`串口: ${s.open ? `已打开 ${s.port} @ ${s.baud}` : '未打开'}  收到 ${s.bytes ?? 0} 字节`];
  for (const line of s.lines ?? []) {
    lines.push(`  ${line.text.replace(/\s+$/, '')}`);
  }
  return lines.join('\n');
}

function renderStack(value) {
  if (!value.ok) return `读取调用栈失败: ${value.error}`;
  const lines = (value.frames ?? []).map((f) => `#${String(f.level).padStart(2)}  ${f.address}  ${f.func ? `${f.func}()` : '??'}  ${f.file}${f.line ? `:${f.line}` : ''}`);
  if (value.variables?.length) {
    lines.push('', '局部变量:');
    for (const v of value.variables) lines.push(`  ${v.arg ? '[参数] ' : ''}${v.name} = ${v.value}`);
  }
  return lines.join('\n') || '调用栈为空';
}
