/**
 * Build backends.
 *
 * - Keil: `UV4.exe -b project.uvprojx -t target -o log` (the exact command MDK's
 *   own command-line build uses).
 * - CMake: configure (if needed) + `cmake --build`.
 * - Makefile: `make -j`.
 *
 * The result is normalised so the panel can show one console and one error list
 * regardless of backend.
 */

import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { ensureDir, fileExists, run, stamp } from '../util.js';
import { exportKeilToCmake } from './export.js';
import { findArtifact } from './project.js';

const UV4_EXIT = {
  0: '成功',
  1: '成功（有警告）',
  2: '有错误',
  3: '致命错误',
  11: '无法打开工程文件',
  12: '无法打开日志文件',
  13: '设备不支持',
  15: '错误太多',
  20: 'License 错误',
};

function parseKeilLog(logText) {
  const errors = [];
  const warnings = [];
  const lines = String(logText).split(/\r?\n/);
  for (const line of lines) {
    const errorMatch = /^(.*?)\((\d+)\):\s*(?:error|Error|ERROR)\s*:?\s*(.*)$/.exec(line.trim());
    if (errorMatch) {
      errors.push({
        file: errorMatch[1].trim(),
        line: Number(errorMatch[2]),
        message: errorMatch[3].trim(),
        raw: line.trim(),
      });
      continue;
    }
    const warningMatch = /^(.*?)\((\d+)\):\s*(?:warning|Warning|WARNING)\s*:?\s*(.*)$/.exec(line.trim());
    if (warningMatch) {
      warnings.push({
        file: warningMatch[1].trim(),
        line: Number(warningMatch[2]),
        message: warningMatch[3].trim(),
      });
      continue;
    }
    if (/^\s*(Error|error):/.test(line) && !/0 Error/.test(line)) {
      errors.push({ file: '', line: 0, message: line.trim(), raw: line.trim() });
    }
  }
  return { errors, warnings };
}

/**
 * @param {object} projectInfo result of inspectProject()
 * @param {object} config
 * @param {{clean?:boolean, target?:string}} [options]
 */
export async function buildProject(projectInfo, config = {}, options = {}) {
  const info = projectInfo.project ?? projectInfo;
  if (!info) throw new Error('没有可构建的工程');
  const startedAt = Date.now();
  const logDir = config.logDir || join(config.dataDir || '.', 'logs');
  ensureDir(logDir);
  const logFile = join(logDir, `build-${stamp()}.log`);

  if (info.kind === 'uvprojx') {
    if (config.uv4Path) return buildWithKeil(projectInfo, config, options, logFile, startedAt);
    return buildKeilViaGcc(projectInfo, config, options, logFile, startedAt);
  }
  if (info.kind === 'cmake') {
    return buildWithCMake(projectInfo, config, options, logFile, startedAt);
  }
  if (info.kind === 'make') {
    return buildWithMake(projectInfo, config, options, logFile, startedAt);
  }
  throw new Error(`未知的工程类型: ${info.kind}`);
}

/**
 * No Keil installed: export the .uvprojx to CMake and build it with GCC.
 * This keeps a Keil project usable on a machine that only has the open-source
 * toolchain (the common case on CI / fresh laptops).
 */
async function buildKeilViaGcc(projectInfo, config, options, logFile, startedAt) {
  if (!config.gccPath) {
    throw new Error(
      '未找到 Keil UV4.exe，也没有 arm-none-eabi-gcc。'
      + '可以二选一：安装 Keil MDK；或在 设置 → STM32 → 工具链 里点「下载并安装工具链」（装了 GCC 后会把 Keil 工程自动导出为 CMake 再编译）。',
    );
  }
  const exported = exportKeilToCmake(projectInfo, {
    dir: options.exportDir || join(projectInfo.project?.dir ?? projectInfo.root ?? '.', '.dsh-gcc'),
  });
  const cmakeConfig = { ...config, buildDir: exported.buildDir };
  if (options.clean) {
    try {
      rmSync(exported.buildDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  const result = await buildWithCMake(
    { kind: 'cmake', root: exported.dir, buildDir: exported.buildDir, project: { kind: 'cmake', dir: exported.dir } },
    cmakeConfig,
    options,
    logFile,
    startedAt,
  );
  const notes = [
    `已从 Keil 工程导出 CMake：${exported.dir}（${exported.sources} 个源文件，${exported.includes} 个 include，${exported.defines} 个宏）`,
    ...exported.skipped.map((item) => `跳过 ${item.name}：${item.reason}`),
    ...exported.remapped.map((item) => `换用 GCC 版本 ${item.to.split(/[\\/]/).slice(-3).join('/')}`),
  ];
  return {
    ...result,
    backend: 'gcc',
    export: {
      dir: exported.dir,
      sources: exported.sources,
      skipped: exported.skipped.length,
      remapped: exported.remapped.length,
    },
    log: `${notes.join('\n')}\n${result.log}`,
    artifacts: collectArtifacts({ buildDir: exported.buildDir }),
  };
}

async function buildWithKeil(projectInfo, config, options, logFile, startedAt) {
  const uv4 = config.uv4Path;
  if (!uv4) {
    throw new Error(
      '未找到 Keil UV4.exe。请安装 MDK 并在设置中填写 UV4 路径，'
      + '或把工程导出为 CMake/Makefile 后使用 arm-none-eabi 后端。',
    );
  }  const info = projectInfo.uvprojx ?? projectInfo;
  const args = ['-j0', '-b', info.path, '-o', logFile];
  const target = options.target || config.target || info.target;
  if (target && info.targets?.includes(target)) args.push('-t', target);
  if (options.clean) args.push('-c');
  const result = await run(uv4, args, { timeoutMs: config.buildTimeoutMs ?? 20 * 60 * 1000 });
  let log = result.stdout + result.stderr;
  if (fileExists(logFile)) {
    try { log = readFileSync(logFile, 'utf8'); } catch { /* keep stdout */ }
  }
  const { errors, warnings } = parseKeilLog(log);
  const artifacts = collectArtifacts(projectInfo);
  return {
    ok: result.code <= 1,
    backend: 'keil',
    code: result.code,
    codeText: UV4_EXIT[result.code] ?? `退出码 ${result.code}`,
    durationMs: Date.now() - startedAt,
    command: result.command,
    log,
    errors,
    warnings,
    artifacts,
    logFile,
  };
}

/**
 * CMake writes compile rules with the bare executable name
 * (`arm-none-eabi-gcc`), so the bin directories must be on PATH during the
 * build step — the user may point us at an .exe that is not on PATH.
 */
function buildEnv(config) {
  const env = { ...process.env };
  const dirs = [
    config.gccPath && dirname(config.gccPath),
    config.ninjaPath && dirname(config.ninjaPath),
    config.openocdPath && dirname(config.openocdPath),
  ].filter(Boolean);
  if (dirs.length) env.PATH = [...new Set(dirs), env.PATH ?? ''].join(delimiter);
  return env;
}

function compilerOverrides(config) {
  const gcc = config.gccPath;
  if (!gcc) return [];
  const dir = dirname(gcc);
  const exe = (name) => join(dir, process.platform === 'win32' ? `${name}.exe` : name);
  return [
    // Bare-metal target: without these CMake treats the compiler as a native
    // Windows one and tries to link against kernel32/user32 etc.
    '-DCMAKE_SYSTEM_NAME=Generic',
    '-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY',
    `-DCMAKE_C_COMPILER=${gcc}`,
    `-DCMAKE_CXX_COMPILER=${exe('arm-none-eabi-g++')}`,
    `-DCMAKE_ASM_COMPILER=${gcc}`,
    `-DCMAKE_OBJCOPY=${exe('arm-none-eabi-objcopy')}`,
    `-DCMAKE_SIZE=${exe('arm-none-eabi-size')}`,
  ];
}

/**
 * Is the existing CMakeCache.txt still usable?
 *
 * CMake bakes absolute paths to the generator (CMAKE_MAKE_PROGRAM) and to
 * cmake itself (CMAKE_COMMAND) into the cache. After the toolchain moves —
 * e.g. from %USERPROFILE%\Downloads to D:\Downloads — those paths go stale and
 * `cmake --build` dies with "no such file or directory" while producing no
 * compiler errors at all. Detect that here so we can silently reconfigure
 * instead of showing a bare "构建失败 (0 个错误)".
 */
function cacheIsStale(cacheFile, config) {
  let text;
  try {
    text = readFileSync(cacheFile, 'utf8');
  } catch {
    return true;
  }
  const read = (key) => {
    const m = new RegExp(`^${key}[^=\\r\\n]*=(.*)$`, 'm').exec(text);
    return m ? m[1].trim().replace(/^"|"$/g, '') : '';
  };
  const checks = [
    ['CMAKE_MAKE_PROGRAM', config.ninjaPath || config.makePath],
    ['CMAKE_COMMAND', config.cmakePath],
  ];
  for (const [key, expected] of checks) {
    const cached = read(key);
    if (!cached) continue;
    // The generator / cmake recorded in the cache is gone from disk.
    if (/[\\/]/.test(cached) && !fileExists(cached)) return true;
    // The user points at a different tool than the one this cache was made with.
    if (expected && cached !== expected) return true;
  }
  return false;
}

async function buildWithCMake(projectInfo, config, options, logFile, startedAt) {
  const { make, cmake, ninja } = toolchainOf(config);
  if (!cmake) throw new Error('未找到 cmake。请安装 CMake 并加入 PATH。');
  if (!config.gccPath && !config.cmakeToolchainFile) {
    throw new Error(
      '未找到 arm-none-eabi-gcc。CMake 工程需要交叉编译器：'
      + '请在 设置 → STM32 里点「下载并安装工具链」，或填写 cmakeToolchainFile 指定工具链文件。',
    );
  }
  const root = projectInfo.root ?? (projectInfo.project?.dir ?? '.');
  const buildDir = config.buildDir || projectInfo.buildDir || join(root, 'build');
  ensureDir(buildDir);
  const cacheFile = join(buildDir, 'CMakeCache.txt');
  const env = buildEnv(config);
  let command = '';
  if (options.clean) {
    try { rmSync(buildDir, { recursive: true, force: true }); } catch { /* ignore */ }
    ensureDir(buildDir);
  }
  // Drop a cache whose recorded tool paths no longer exist (toolchain was
  // moved/reinstalled), otherwise `cmake --build` fails with no diagnostics.
  if (fileExists(cacheFile) && cacheIsStale(cacheFile, config)) {
    try { rmSync(buildDir, { recursive: true, force: true }); } catch { /* ignore */ }
    ensureDir(buildDir);
  }
  if (!fileExists(cacheFile)) {
    const generator = ninja ? 'Ninja' : (process.platform === 'win32' ? 'MinGW Makefiles' : 'Unix Makefiles');
    const configureArgs = ['-S', root, '-B', buildDir, '-G', generator];
    if (ninja) configureArgs.push(`-DCMAKE_MAKE_PROGRAM=${ninja}`);
    if (config.cmakeToolchainFile) configureArgs.push(`-DCMAKE_TOOLCHAIN_FILE=${config.cmakeToolchainFile}`);
    if (config.cmakeBuildType) configureArgs.push(`-DCMAKE_BUILD_TYPE=${config.cmakeBuildType}`);
    configureArgs.push(...compilerOverrides(config));
    (config.cmakeExtraArgs ?? []).forEach((a) => configureArgs.push(a));
    const configure = await run(cmake, configureArgs, { timeoutMs: 5 * 60 * 1000, env });
    command = configure.command;
    if (!configure.ok) {
      return {
        ok: false,
        backend: 'gcc',
        code: configure.code,
        durationMs: Date.now() - startedAt,
        command,
        log: `${configure.stdout}\n${configure.stderr}`,
        errors: [{ file: '', line: 0, message: 'CMake 配置失败' }],
        warnings: [],
        artifacts: [],
        logFile,
      };
    }
  }
  if (!make && !ninja) throw new Error('未找到 make/ninja，无法执行 CMake 构建。');
  const buildArgs = ['--build', buildDir, '--parallel'];
  let build = await run(cmake, buildArgs, { timeoutMs: config.buildTimeoutMs ?? 20 * 60 * 1000, env });
  let log = `${build.stdout}\n${build.stderr}`;
  // A stale cache can also blow up mid-build ("build tool execution failed"):
  // wipe, reconfigure and retry once so the user gets a real diagnostic.
  if (!build.ok && /no such file or directory|build tool execution failed|CMAKE_MAKE_PROGRAM/i.test(log)) {
    try { rmSync(buildDir, { recursive: true, force: true }); } catch { /* ignore */ }
    ensureDir(buildDir);
    const generator = ninja ? 'Ninja' : (process.platform === 'win32' ? 'MinGW Makefiles' : 'Unix Makefiles');
    const configureArgs = ['-S', root, '-B', buildDir, '-G', generator];
    if (ninja) configureArgs.push(`-DCMAKE_MAKE_PROGRAM=${ninja}`);
    if (config.cmakeToolchainFile) configureArgs.push(`-DCMAKE_TOOLCHAIN_FILE=${config.cmakeToolchainFile}`);
    if (config.cmakeBuildType) configureArgs.push(`-DCMAKE_BUILD_TYPE=${config.cmakeBuildType}`);
    configureArgs.push(...compilerOverrides(config));
    (config.cmakeExtraArgs ?? []).forEach((a) => configureArgs.push(a));
    const configure = await run(cmake, configureArgs, { timeoutMs: 5 * 60 * 1000, env });
    if (configure.ok) {
      build = await run(cmake, buildArgs, { timeoutMs: config.buildTimeoutMs ?? 20 * 60 * 1000, env });
      log = `(重新配置 CMake：缓存的工具路径已失效)\n${configure.stdout}\n${configure.stderr}\n${build.stdout}\n${build.stderr}`;
    } else {
      log = `${configure.stdout}\n${configure.stderr}`;
    }
  }
  command = build.command;
  const { errors, warnings } = parseGccLog(log);
  if (!errors.length && !build.ok) {
    // Surface why a build failed even when the compiler printed no `error:`.
    const tail = log.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-6).join(' · ');
    errors.push({ file: '', line: 0, message: tail || `构建工具退出码 ${build.code}`, raw: tail });
  }
  const artifacts = collectArtifacts({ ...projectInfo, buildDir });
  return {
    ok: build.ok,
    backend: 'gcc',
    code: build.code,
    durationMs: Date.now() - startedAt,
    command,
    log,
    errors,
    warnings,
    artifacts,
    logFile,
  };
}

async function buildWithMake(projectInfo, config, options, logFile, startedAt) {
  const { make } = toolchainOf(config);
  if (!make) throw new Error('未找到 make。');
  const dir = projectInfo.project?.dir ?? projectInfo.root ?? '.';
  const args = ['-j'];
  if (options.target) args.push(options.target);
  if (options.clean) args.push('clean');
  const build = await run(make, args, { cwd: dir, timeoutMs: config.buildTimeoutMs ?? 20 * 60 * 1000 });
  const log = `${build.stdout}\n${build.stderr}`;
  const { errors, warnings } = parseGccLog(log);
  return {
    ok: build.ok,
    backend: 'gcc',
    code: build.code,
    durationMs: Date.now() - startedAt,
    command: build.command,
    log,
    errors,
    warnings,
    artifacts: collectArtifacts(projectInfo),
    logFile,
  };
}

function toolchainOf(config) {
  return {
    cmake: config.cmakePath,
    make: config.makePath,
    ninja: config.ninjaPath,
  };
}

function parseGccLog(logText) {
  const errors = [];
  const warnings = [];
  for (const raw of String(logText).split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(.*?):(\d+):(?:(\d+):)?\s*(error|warning|fatal error):\s*(.*)$/i.exec(line);
    if (m) {
      const entry = { file: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : 0, message: m[5], raw: line };
      if (/error/i.test(m[4])) errors.push(entry);
      else warnings.push(entry);
      continue;
    }
    if (/undefined reference to|multiple definition of|ld returned \d+ exit status/i.test(line)) {
      errors.push({ file: '', line: 0, message: line, raw: line });
    }
  }
  return { errors, warnings };
}

function collectArtifacts(projectInfo) {
  const dir = projectInfo.buildDir || projectInfo.uvprojx?.output?.dirAbs || projectInfo.root;
  if (!dir) return [];
  return findArtifact(dir).slice(0, 8);
}
