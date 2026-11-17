# dsh-stm32-toolkit

简体中文 | [English](./README.en.md)

> **在 DSH 里编译、下载、调试 STM32，让 Agent 和你一起开发。**

[![npm](https://img.shields.io/npm/v/@lylgj/dsh-stm32-toolkit?style=flat-square)](https://www.npmjs.com/package/@lylgj/dsh-stm32-toolkit)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

<img src="docs/assets/banner.png" alt="dsh-stm32-toolkit 开发工作台" width="100%">

DeepSeek Harness 的 STM32 开发插件。通过侧边栏工作台、19 个 Agent 工具和 `/stm32` 命令，完成从工程识别、编译、固件下载到在线调试的开发流程，三种入口共用同一套工程与配置。

[安装](#安装) · [快速开始](#快速开始) · [环境要求](#环境要求) · [工具与命令](#工具与命令) · [卸载](#卸载)

## 界面预览

<img src="docs/assets/screenshots/console.png" alt="STM32 工作台：工程、探针、编译、下载、调试和芯片状态" width="100%">

## 功能

- **工程与编译**：识别 Keil `.uvprojx`、CMake 和 Makefile 工程；使用 Keil 或 GCC 编译；未安装 Keil 时，自动将 `.uvprojx` 导出为 CMake / GCC 工程后构建。
- **固件下载**：按扇区或整片擦除、校验和复位；ST-Link / CMSIS-DAP 使用 OpenOCD，J-Link 可使用 SEGGER 原生后端。
- **在线调试**：暂停、继续、单步和复位；执行断点、条件断点和数据监视点。
- **芯片状态**：内核与外设寄存器、SVD 位域、内存、调用栈、局部变量、表达式和反汇编。
- **串口与 RTT**：发现串口、文本 / HEX 通信，以及通过 OpenOCD 查看 SEGGER RTT 日志。
- **辅助工具**：符号查询、静态引脚图、CubeMX `.ioc` 编辑、基础 CMake 工程创建，以及 GCC / OpenOCD 安装。

## 安装

### DSH 桌面版

打开 **插件 → 添加插件**，输入以下包名，通过应用内的插件管理器安装：

```text
@lylgj/dsh-stm32-toolkit
```

完全退出并重新打开 DSH，然后点击侧边栏的 **STM32**。

### CLI：dsh web / 自定义 profile

```sh
dsh plugin --profile web add @lylgj/dsh-stm32-toolkit
```

如有需要，将 `web` 换成实际 profile 名称，然后重启对应 DSH 实例。

## 快速开始

1. 打开 **STM32 → 设置**，选择工程目录，确认芯片型号。
2. 检查工具链。**下载并安装工具链** 可安装 GCC / OpenOCD；CMake、Ninja / Make、Keil 和 SEGGER J-Link 软件需按项目要求另外准备。
3. 选择探针及下载 / 调试后端。连接开发板，检查供电、驱动和 SWD / JTAG 接线。
4. 先 **编译**，确认生成的固件后再 **下载**，然后启动调试，查看断点、寄存器和内存。

也可以直接对 Agent 说：

```text
检查 STM32 开发环境，告诉我缺少哪些工具。
打开 D:\work\demo_project 并编译，先不要下载。
确认固件后下载并校验，然后启动调试，在 main 停下来。
查看 GPIOA 寄存器和当前调用栈。
```

## 环境要求

DSH **0.2.2-rc.1 或更新版本**、Node.js **20 或更新版本**。根据工作场景安装所需工具：

| 场景 | 所需工具 |
|---|---|
| Keil 编译 | Keil MDK / UV4，以及工程所需的编译器与器件包 |
| CMake 工程 / Keil 导出工程 | arm-none-eabi-gcc、CMake，以及 Ninja 或 Make |
| Makefile 工程 | arm-none-eabi-gcc、Make |
| ST-Link / CMSIS-DAP 下载与调试 | OpenOCD 和探针驱动；调试另需 arm-none-eabi-gdb |
| J-Link 原生下载与调试 | SEGGER J-Link 软件；调试另需 arm-none-eabi-gdb |
| RTT 日志 | OpenOCD，以及固件中已集成的 SEGGER RTT 组件 |

桌面版通常自带 Node.js 运行环境，无需单独安装。工具路径通常可自动探测，也可以在工作台 **设置** 中指定。

## 工具与命令

| 分组 | 工具 |
|---|---|
| 工程与配置 | `stm32_project`、`stm32_doctor`、`stm32_config`、`stm32_env` |
| 编译与下载 | `stm32_build`、`stm32_export`、`stm32_flash` |
| 调试控制 | `stm32_debug`、`stm32_breakpoint` |
| 芯片状态 | `stm32_registers`、`stm32_memory`、`stm32_stack`、`stm32_watch`、`stm32_disasm` |
| 辅助功能 | `stm32_serial`、`stm32_rtt`、`stm32_symbols`、`stm32_pins`、`stm32_ioc` |

手动命令包括 `/stm32 status`、`/stm32 build`、`/stm32 flash`、`/stm32 debug start` 和 `/stm32 regs GPIOA`。

## 使用提示

- Keil 工程导出并不保证兼容所有 ARMCC 专用语法、库和链接配置；必要时使用 Keil 后端。
- 修改 .ioc 不等于调用 CubeMX 生成完整 HAL 工程；内置创建功能提供基础工程骨架。
- 引脚图来自静态扫描，复杂宏和间接调用可能无法识别，请结合原理图与实际工程核对。

## 硬件操作安全

下载、擦除、写内存和运行代码都会改变真实硬件状态。操作前请确认目标芯片、固件、地址与擦除选项。重要数据先备份，启动或继续运行前应确保外接设备可以安全工作。

## 卸载

在 DSH 桌面版的 **插件** 页面找到本插件，选择 **卸载**，然后完全退出并重新打开 DSH。

使用 CLI 时，在安装插件的同一个 profile 中执行：

```sh
dsh plugin --profile web remove @lylgj/dsh-stm32-toolkit
```

将 `web` 换成实际 profile 名称，然后重启对应 DSH 实例。

## 许可

[MIT](./LICENSE)。Keil、SEGGER 软件、GCC、OpenOCD、SVD 文件和工程依赖各自遵循其许可。插件的 MIT 许可不替代这些组件的授权。第三方工具由本机安装或按需下载，不随插件附带分发。
