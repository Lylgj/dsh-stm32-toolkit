<div align="center">

<img src="docs/assets/banner.png" alt="dsh-stm32-toolkit" width="100%">

# 🧩 dsh-stm32-toolkit

**Build, flash and debug STM32 inside DeepSeek Harness — with the agent in the loop.**

A DeepSeek Harness plugin: a sidebar workbench, 19 agent tools and the `/stm32` command share one project, one config file and one debug session.
Projects can be Keil `.uvprojx`, CMake or Makefile; builds go through Keil UV4 or arm-none-eabi-gcc,
firmware is written over OpenOCD or SEGGER J-Link, and GDB drives the debug session.

[![npm version](https://img.shields.io/npm/v/@lylgj/dsh-stm32-toolkit?style=flat-square)](https://www.npmjs.com/package/@lylgj/dsh-stm32-toolkit)
[![npm downloads](https://img.shields.io/npm/dm/@lylgj/dsh-stm32-toolkit?style=flat-square)](https://www.npmjs.com/package/@lylgj/dsh-stm32-toolkit)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.2--rc.1-blueviolet?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

[简体中文](README.md) · [English](README.en.md)

```sh
dsh plugin --profile web add @lylgj/dsh-stm32-toolkit
```

</div>

> Main repository: <https://github.com/Lylgj/dsh-stm32-toolkit>　·　npm page: <https://www.npmjs.com/package/@lylgj/dsh-stm32-toolkit>　·　License: [MIT](./LICENSE)

## Interface

![STM32 workbench](docs/assets/screenshots/console.png)

The panel lives under "STM32" in the sidebar: a toolbar with the project selector, debugger, erase mode and Build / Download / Debug, then tabs for console, source, memory, disassembly, serial, RTT, symbols, pins and settings.
Starting a debug session opens a second window holding the source tree, locals, call stack, registers and watch expressions.

## Install

### 1. Desktop app

1. Open the DSH desktop app and go to the Plugins page.
2. Click "Add plugin" and enter `@lylgj/dsh-stm32-toolkit`, or the absolute path of a local checkout.
3. When it finishes, **quit DSH completely** (including the tray icon) and start it again; an "STM32" entry in the sidebar means it is loaded.

### 2. Command line

```sh
dsh plugin --profile web add @lylgj/dsh-stm32-toolkit       # web profile
dsh plugin --profile desktop add @lylgj/dsh-stm32-toolkit   # desktop app
```

`--profile` must match the instance you actually run; installing into another profile leaves the panel invisible. A full restart is required either way.

### 3. From source

```sh
git clone https://github.com/Lylgj/dsh-stm32-toolkit.git
cd dsh-stm32-toolkit
dsh plugin --profile web add <absolute path to this checkout>
```

Use an absolute path. After editing `src/` or `client.js`, run `add` again so DSH reloads the plugin.

### 4. Upgrade and uninstall

```sh
dsh plugin --profile web add @lylgj/dsh-stm32-toolkit@latest   # upgrade
dsh plugin --profile web remove @lylgj/dsh-stm32-toolkit        # uninstall
```

The desktop app upgrades and removes plugins from the Plugins page. Removing the plugin leaves `<DSH_HOME>/stm32/` (config file and downloaded toolchain) untouched; delete that directory yourself if you want it gone.

### 5. A full restart is required

After install, upgrade or uninstall, **restart DSH completely**: the panel, the 19 tools and the `/stm32` command are registered at process start, so closing the window or reloading the page is not enough. In the desktop app, quit from the tray menu and launch it again.

## First run

1. Open the workbench from "STM32" in the sidebar.
2. Click the project button and pick a directory containing `.uvprojx`, `CMakeLists.txt` or a `Makefile`; check the detected chip.
3. Open Settings and look at the toolchain status; missing GCC / OpenOCD? Click "Download and install toolchain", or have the agent call `stm32_env`.
4. In the toolbar pick a debugger (ST-Link / CMSIS-DAP / J-Link) and an erase mode (sector / mass); leave the backend on `auto`.
5. Click Build. The first build picks UV4, CMake or make depending on the project type; the log streams into the console.
6. Click Download to write the chip, then Debug to start a session: the program stops in `main`, and you can step, inspect registers and set breakpoints from there.

You can also just tell the agent:

- Check my STM32 environment and list what is missing.
- Open `D:\work\demo`, build it, do not flash yet.
- Once the build passes, flash the firmware and verify it.
- Start debugging, stop in `main`, then read the GPIOA registers.
- Show me the current call stack and locals, then continue to the next breakpoint.

## Requirements

### What the one-click install provides

"Download and install toolchain" in Settings (the `install` action of `stm32_env` for the agent) fetches two **Windows x64** archives from xPack's GitHub releases:

| Component | Version | What you get |
|---|---|---|
| arm-none-eabi-gcc | 15.2.1-1.1 | `arm-none-eabi-gcc`, `arm-none-eabi-gdb` |
| OpenOCD | 0.12.0-7 | `openocd` |

They are extracted into `<DSH_HOME>/stm32/tools/` and wired into the config; the downloads total roughly 300 MB. On other platforms install the toolchain yourself and point the plugin at it in Settings or through `stm32_config`. Readiness is `uv4 || (gcc && gdb && (openocd || jlink))`.

### What you provide

- **CMake plus Ninja or Make**: for CMake projects and for GCC builds of exported Keil projects; without Ninja, Windows falls back to MinGW Makefiles.
- **Keil MDK**: needed when UV4 serves as the build or flash backend, and the plugin must be able to locate UV4.
- **SEGGER J-Link software**: needed for the J-Link flash and debug backend (`JLink.exe`, `JLinkGDBServerCL`); install probe drivers per vendor instructions.
- **SVD file**: required for the register view; matched from the chip when possible and otherwise fetched from cmsis-svd.

### Project type vs. required tools

| Project type | Build | Flash / debug |
|---|---|---|
| Keil `.uvprojx` | UV4, or `stm32_export` then GCC | UV4, OpenOCD, J-Link |
| CMake (`CMakeLists.txt`) | CMake + Ninja/Make + GCC | OpenOCD, J-Link |
| Makefile | make + GCC | OpenOCD, J-Link |
| Firmware only | none | OpenOCD, J-Link, UV4 |

## Agent tools

**Project and environment**

| Tool | What it does |
|---|---|
| `stm32_project` | Inspect or switch the current project; returns chip, artifacts and SVD |
| `stm32_doctor` | Check UV4, GCC/GDB, OpenOCD, J-Link, CubeProgrammer and attached probes |
| `stm32_config` | Read or patch config; writes `<DSH_HOME>/stm32/config.json` |
| `stm32_env` | Report toolchain status, or download and install GCC / OpenOCD |

**Build and flash**

| Tool | What it does |
|---|---|
| `stm32_build` | Build the project; UV4 `-b` for Keil, CMake / make otherwise |
| `stm32_export` | Export a Keil project to CMake + GCC, default output `<project>/.dsh-gcc` |
| `stm32_flash` | Flash firmware, optionally mass-erase, verify and reset |

**Debugging**

| Tool | What it does |
|---|---|
| `stm32_debug` | Start / stop a session, continue, pause, step, reset, report status |
| `stm32_breakpoint` | Code breakpoints and read / write / access watchpoints, with conditions and hardware mode |
| `stm32_registers` | Core registers, or peripheral registers decoded from SVD |
| `stm32_memory` | Read / write target memory as hex bytes |
| `stm32_stack` | Call stack plus locals of the current frame |
| `stm32_watch` | Evaluate a C expression or variable |
| `stm32_disasm` | Disassemble target code |

**Peripherals and helpers**

| Tool | What it does |
|---|---|
| `stm32_serial` | Serial monitor and I/O, works without a debug session |
| `stm32_rtt` | Read / write SEGGER RTT logs through OpenOCD |
| `stm32_symbols` | Look up symbols by name or address from a `.map` or ELF |
| `stm32_pins` | Pin usage map from source scanning and `.ioc` |
| `stm32_ioc` | Read / patch `.ioc`, or generate a minimal CMake skeleton |

Key defaults: `backend auto`, `probe stlink`, `adapterSpeed 4000`, `gdbPort 3333`, `telnetPort 4444`, `flashErase none`, `flashVerify` and `flashReset` on, `serialBaud 115200`, `rttPort 9090`, `runToMain` on — persisted in `<DSH_HOME>/stm32/config.json`.

## Commands

| Subcommand | Effect |
|---|---|
| `/stm32 help` | List all subcommands |
| `/stm32 status` | Project, backend and debug session status |
| `/stm32 project [dir]` | Inspect or switch the current project |
| `/stm32 build [clean]` | Build; `clean` cleans first |
| `/stm32 flash` | Flash the current firmware |
| `/stm32 debug start\|stop\|status\|<action>` | Start, stop, report, or send continue / pause / step |
| `/stm32 regs [peripheral]` | Read registers |
| `/stm32 mem <address> [count]` | Read memory |
| `/stm32 stop` | Stop the debug session |

## Tips

- Run `stm32_doctor` or `/stm32 status` first; the `auto` backend picks OpenOCD or J-Link based on the probe and installed tools.
- `.bin` needs a load address: the call argument wins, then `binAddress`, then the scatter-file or memory-map guess; `.hex` and `.elf` normally need nothing.
- Live debugging needs GDB plus OpenOCD or J-Link GDB Server; with UV4 alone you can flash, but not debug online.
- `stm32_export` writes a GCC project only and never modifies the original Keil project; build and flash time out at 1200000 ms by default.

## Known limits

- The Keil-to-CMake export covers the common case, i.e. C/C++/assembly sources that already build with GCC. ARMCC-only sources (for example FreeRTOS RVDS ports) are replaced by their GCC sibling when the pack ships one, and otherwise skipped and reported.
- The pin map is static: it scans `HAL_GPIO_Init` and `HAL_GPIO_WritePin`, expands `#define`s, then merges `.ioc` signals; complex macros, indirect calls and runtime-only directions can be missed.
- RTT works through OpenOCD's telnet channel and is unavailable with a J-Link-only backend.
- `stm32_ioc` `set` only edits the file; `create` writes a minimal CMake skeleton, never a full CubeMX project.
- One-click install and probe detection are implemented for Windows x64, so other platforms need a toolchain supplied by hand; the workbench polls state about once per second while builds and flashes run in the background.

## Safety

- Flashing, erasing, writing memory and resetting change hardware state immediately. Confirm that the project, the firmware and the probe all point at the same board; a mass erase wipes the program and data area.
- Check the address before flashing a `.bin`; the IAP guess is only a suggestion, and a wrong address can overwrite the bootloader.
- Debugging halts the CPU. Mind the watchdog and the state of motors, heaters, power rails and other peripherals while halted.
- The one-click install downloads and extracts executables from GitHub; make sure the network path is trustworthy.

## Versions and compatibility

- Plugin version 0.1.1; Node.js ≥ 20; DeepSeek Harness ≥ 0.2.2-rc.1.
- Compatibility markers: `0.2.2-alpha.3` incompatible, `0.2.2-rc.1` compatible, `0.2.2-rc.2` unknown.
- Optional peer dependency `@deepseek-ai/dsh-tools` ≥ 0.1.0-rc.7; the client panel is built for the web platform and renders inside the DSH web UI.

## License

MIT
