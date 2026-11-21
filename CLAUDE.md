# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

`@jswork/wk-bridge` 是一个已落地的 NPM 库：WKWebView 场景下 H5 侧使用的通用 bridge 客户端。它负责协议中的页面一半——Promise 化请求、事件订阅、超时/取消、错误码、mock 适配。原生 Swift 侧不在本仓库内，集成说明见 `docs/native-integration.md`。

协议与消息形状以 `docs/protocol.md` 为准，不要在各处另立一套约定。

## 常用命令

- `pnpm install` — 安装依赖（包管理器固定 pnpm）
- `pnpm build` — tsup 构建（CJS + ESM + dts，产物在 `dist/`）
- `bun test` — 运行测试（bun test runner，不是 jest/vitest）
- `bun test __tests__/bridge.spec.ts` — 运行单个测试文件
- `pnpm release` — release-it 发布（版本号 → 构建 → GitHub release；hooks 在 `.release-it.json`）

## 架构

`src/` 按职责拆分，`src/index.ts` 只做汇总导出：

- `types.ts` — 公开类型：`MethodMap` / `EventMap` / `MethodSpec`、`ParamsOf` / `ResultOf`、消息形状、`BridgeOptions`、`Bridge` 接口。
- `errors.ts` — `BridgeError` 与内置 `ErrorCodes`。
- `constants.ts` — 版本号、默认 channel / timeout / 全局键。
- `emitter.ts` — 内部事件发射器（once、错误隔离、退订）。
- `transport.ts` — 懒检测 `webkit.messageHandlers[channel]`。
- `bridge.ts` — `createBridge`：请求表、超时、abort、receive、全局接收器、inbox 排空、destroy。
- `mock.ts` — `createMockBridge`：内存 transport、延迟、`calls` 记录、`emit`。
- `index.ts` — 命名导出 + 默认导出 `createBridge`。

测试在 `__tests__/`，用 `bun:test`，覆盖真实 transport 与 mock 两条路径。

构建配置（tsup.config.ts）：

- 单入口 `src/index.ts`，产出 CJS（`index.cjs.js`）和 ESM（`index.esm.js`），含 dts 和 banner（`@jswork/tsup-banner`）
- `outExtension` 将产物重命名为 `.<format>.js`
- 无 UMD 构建；`package.json` 中 `sideEffects: false`，保持可 tree-shake

## 约定

- 包管理器：**pnpm**
- 测试：bun test（使用 `bun:test` 的 `expect` / `describe` / `test`）
- 源码注释：英文，公开 API 使用标准 TSDoc（`@param` / `@returns` / `@typeParam` / `@public` / `@see`）
- 协议变更必须同步：`docs/protocol.md`、`docs/native-integration.md`、`README.md`、`llms.txt`
- 源码更新后：`README.md` 和 `llms.txt` 必须同步更新（保持文档与实际导出/用法一致）
- 新增公开导出时同步更新 `src/index.ts`、README 的 API 表与 `llms.txt`
- release-it hooks 使用 **pnpm**，其中包含个人机器依赖（`t2k`、`cnpm sync`、GitHub proxy）——除非明确要求，否则保留它们
- `docs/superpowers/` 是模板遗留的工程质量计划，非本包文档
