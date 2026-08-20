# 柳（Yanagi）· 视觉小说引擎

Web 优先（GitHub Pages 子路径发布）+ Tauri 桌面双端的 TypeScript 视觉小说引擎。
设计文档：主页仓库 `tsunami2576.github.io/vn-engine/WHITEPAPER.md`（v1.1）。
进度：`PROGRESS.html`（浏览器打开）· `docs/ITERATIONS.md` · `docs/DECISIONS.md`。

## 快速开始

```bash
pnpm install
pnpm gen:assets        # 重新生成 demo 占位资产（SVG+WAV）
pnpm test              # 内核 + 解析器测试
pnpm typecheck
pnpm dev               # canary demo 开发服务器（games/demo）
pnpm build             # demo 生产构建
```

## Monorepo 布局

| 包 | 职责 |
|---|---|
| `packages/core` | 内核：指令集 / VM / 表达式 / GameState / 存档快照（零平台依赖） |
| `packages/script` | Yanagi Script（`.yn`）手写解析器 + 编译器 + Vite 插件（`virtual:yanagi-game`） |
| `packages/ui` | DOM UI：文本窗（打字机）/ 选择肢 / 标题 / 设置 / 存档 / 想起 / 暂停菜单 + 主题样式 |
| `packages/stage-pixi` | PixiJS v8 舞台：背景 / 立绘 / 转场 / 聚焦 / 震屏 / 闪光 |
| `packages/audio-web` | Web Audio 混音器：四总线 / 循环点 / 交叉淡化 / ducking / 手势解锁 |
| `packages/runtime` | 会话编排：输入 / 存储适配（IndexedDB，失败降级内存）/ 事件分发 / 自动存档 |
| `games/demo` | canary 游戏工程（永远使用全部已发布特性） |

## 剧本速览（story/*.yn）

```
yui「[ruby:放課後;ほうかご]的教室，果然还是太安静了呢。」voice=yui_0101
@bg classroom_afternoon fade=800
@choice「怎么回答？」
  「留下来陪你」 -> ch1_stay
  「（装作没听见）」 -> ch1_silence once
@end
```
