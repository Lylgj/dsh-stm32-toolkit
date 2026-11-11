/**
 * `/stm32` slash command: quick access to the same service from the composer.
 *
 * Usage:
 *   /stm32 status
 *   /stm32 build
 *   /stm32 flash
 *   /stm32 debug start|stop|pause|continue|step
 *   /stm32 regs [GPIOA]
 *   /stm32 mem 0x20000000 [64]
 */

const HELP = [
  '用法: /stm32 <子命令>',
  '  status            环境与工程状态',
  '  project [目录]    查看/切换工程',
  '  build [clean]     编译',
  '  flash             下载固件',
  '  debug start|stop|pause|continue|step',
  '  regs [外设名]     内核寄存器或外设寄存器',
  '  mem <地址> [字节数] 读取内存',
  '  stop              结束调试会话',
].join('\n');

function success(text) {
  return { kind: 'success', text };
}

function error(text) {
  return { kind: 'error', text };
}

export function registerCommands(ctx, service) {
  let commands;
  try {
    commands = ctx.get('commands');
  } catch {
    commands = null;
  }
  if (!commands?.register) return false;

  commands.register({
    name: 'stm32',
    description: 'STM32 工程：编译、下载、调试、寄存器',
    input: { hint: 'status | build | flash | debug start|stop | regs GPIOA | mem 0x20000000' },
    async handler(invocation) {
      const raw = String(invocation?.rawInput ?? invocation?.input ?? '').trim();
      const [sub, ...rest] = raw.split(/\s+/);
      try {
        if (!sub || sub === 'help') return success(HELP);
        switch (sub) {
          case 'status': {
            await service.getToolchain();
            const info = service.project ?? await service.inspect(service.config.projectDir);
            return success([
              `工程: ${info.root}`,
              `类型: ${info.project?.kind ?? '未识别'}  芯片: ${info.device || '未知'}`,
              `后端: ${info.backend}  固件: ${info.artifact || '尚未构建'}`,
              `调试: ${service.debug.state().active ? (service.debug.state().running ? '运行中' : '已暂停') : '未启动'}`,
              service.toolchain ? `工具链: Keil=${service.toolchain.keil.installed ? '有' : '无'} gcc=${service.toolchain.gcc.installed ? '有' : '无'} openocd=${service.toolchain.openocd.installed ? '有' : '无'}` : '',
            ].filter(Boolean).join('\n'));
          }
          case 'project': {
            const info = await service.inspect(rest.join(' ') || service.config.projectDir, true);
            return success(`${info.root}\n${info.project?.kind ?? '未识别'}  ${info.device ?? ''}\n${info.artifact ?? ''}`);
          }
          case 'build': {
            const result = await service.build({ clean: rest[0] === 'clean' });
            if (!result.ok) {
              const first = result.errors?.[0];
              return error(`构建失败${first ? `: ${first.file}:${first.line} ${first.message}` : ''}\n${result.log?.slice(-800) ?? ''}`);
            }
            return success(`构建成功 (${(result.durationMs / 1000).toFixed(1)}s)\n${(result.artifacts ?? []).map((a) => a.path).join('\n')}`);
          }
          case 'flash': {
            const result = await service.flash();
            return result.ok ? success(`下载成功 (${(result.durationMs / 1000).toFixed(1)}s)`) : error(`下载失败\n${String(result.output ?? '').slice(-800)}`);
          }
          case 'debug': {
            const action = rest[0] ?? 'status';
            if (action === 'start') {
              const state = await service.debugStart();
              return success(`调试已启动${state.stop ? `，停在 ${state.stop.func} ${state.stop.file}:${state.stop.line}` : ''}`);
            }
            if (action === 'stop') {
              await service.debugStop();
              return success('调试已结束');
            }
            if (action === 'status') {
              const state = service.debug.state();
              return success(state.active ? `调试中: ${state.running ? '运行' : '暂停'} ${state.stop?.func ?? ''}` : '调试未启动');
            }
            const result = await service.debugAction(action, { waitMs: 1500 });
            const stop = result.stop ?? service.debug.state().stop;
            return success(`${action}: ${stop ? `${stop.func} ${stop.file}:${stop.line}` : '运行中'}`);
          }
          case 'regs': {
            if (!service.debug.active) return error('调试未启动，请先 /stm32 debug start');
            if (rest[0]) {
              const data = await service.debug.peripheral(rest[0]);
              return success(data.registers.map((r) => `${r.name.padEnd(12)} ${r.value}`).join('\n'));
            }
            const data = await service.debug.registers();
            return success(data.registers.map((r) => `${r.name.padEnd(8)} ${r.value}`).join('\n'));
          }
          case 'mem': {
            if (!service.debug.active) return error('调试未启动，请先 /stm32 debug start');
            const data = await service.debug.readMemory(rest[0], Number(rest[1] ?? 64));
            const bytes = data.bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
            return success(`${data.address}: ${bytes}`);
          }
          case 'stop': {
            await service.debugStop();
            return success('调试已结束');
          }
          default:
            return error(`未知子命令 "${sub}"\n${HELP}`);
        }
      } catch (err) {
        return error(String(err?.message ?? err));
      }
    },
  });
  return true;
}
