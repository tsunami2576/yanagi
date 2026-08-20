# 决策日志（ADR）

> 记录所有偏离白皮书（主页仓库 `vn-engine/WHITEPAPER.md`）的实现决策。格式：编号 / 日期 / 决策 / 理由 / 影响。被推翻的决策移入文末"已推翻"区。

## D-001 · 剧本解析器：手写递归下降，不用 Peggy

- **日期**：2026-08-20
- **决策**：词法、行结构、命令参数、行内标记、表达式全部手写递归下降/扫描器实现。
- **理由**：Yanagi Script 是行式语言，手写解析器能给出最精确的"文件:行:列 + 上下文"报错（作者体验的一等需求），并减少一个构建期依赖。白皮书 v1.1 已同步修订。
- **影响**：`packages/script` 无运行时依赖；语法扩展时需要自己维护算符优先级表。Peggy 保留为后备（若未来引入复杂语法如内嵌表达式 DSL 升级）。

## D-002 · dev/build 管线用 Vite 虚拟模块先行，独立 CLI 后置到 M3

- **日期**：2026-08-20
- **决策**：`@yanagi/script/vite` 插件提供 `virtual:yanagi-game` 虚拟模块（编译剧本 + 扫描资产 + 生成 manifest + 资源存在性校验），dev/build 均走 Vite；`yanagi` CLI（new/dev/check/build 子命令与资产管线 sharp/ffmpeg）后置到 M3。
- **理由**：先打通"写剧本→可玩"的最短路径；CLI 本质是同一编译 API 的包装，晚做不返工。
- **影响**：M0–M2 期间新建游戏 = 复制 `games/demo` 目录模板（文档明示）。

## D-003 · canary demo 资产用确定性生成脚本（SVG 背景/立绘 + WAV 音频）

- **日期**：2026-08-20
- **决策**：`games/demo/tools/gen-assets.mjs` 生成全部占位资产；资产提交入库。
- **理由**：本机无 ffmpeg；生成脚本保证 demo 在任何环境可重建、自包含、无版权问题；替换真实资产时只换文件不换管线。
- **影响**：占位立绘为几何图形 SVG，不阻挡引擎逻辑验证。

## D-004 · 游戏配置用 game.json 而非 game.yaml

- **日期**：2026-08-20
- **决策**：游戏工程配置（标题/角色表/BGM 循环点）用 JSON。
- **理由**：零 YAML 依赖（避免引入 js-yaml）；配置面小，JSON 注释缺失可接受（角色色值等可在白皮书/文档中说明）。
- **影响**：若未来配置膨胀（主题/多语言/章节元数据），再评估迁移 YAML 或 TOML。

## D-005 · M0 范围裁剪：命令全集"解析期完整、运行期部分 no-op"

- **日期**：2026-08-20
- **决策**：v0.1 全部命令（含 `@weather/@filter/@fg`）在解析与编译层完整支持（参数校验/状态入档）；M0 运行期 `@weather/@filter/@fg` 为带提示的 no-op（console info 一次），M1 落地渲染。
- **理由**：语法面尽早冻结（白皮书 §6 是最难改的部分），演出效果可以增量补。
- **影响**：demo 剧本可立即使用全语法；M1 补齐渲染时无需改剧本。

## D-006 · script/compile.ts 对 core 用相对导入（Vite config loader 限制）

- **日期**：2026-08-20
- **决策**：`vite.config.ts` → `packages/script/src/vite-plugin.ts` 这条"配置加载链"会被 esbuild 打包，但**裸导入会被外部化**，Node 原生 ESM 无法加载 workspace 包的 `.ts` 源（extensionless 相对导入不可解析）。因此 `compile.ts`（链上唯一的 core **值导入**方）改用 `../../core/src/index` 相对导入；其余包对 core 的导入均为 type-only（会被擦除），不受影响。
- **理由**：避免在 M0 引入包构建步骤（tsc dist + exports map）。
- **影响**：M3 为引擎包增加 dist 构建后恢复包名导入；届时删除此决策。

## D-007 · 构建时强制 pixi 单 chunk（跨 chunk 循环继承挂起）

- **日期**：2026-08-20
- **决策**：demo 的 vite 配置用 `manualChunks` 把所有 pixi 模块并入单一 chunk；同时 `Application.init` 固定 `preference:'webgl'`。
- **理由**：rollup 默认拆分时，pixi v8 渲染器体系的跨 chunk 循环继承会让 `app.init()` **永久挂起**（无报错、dev 模式不复现，极难排查）；WebGPU 优先策略在无头/CI 环境差异大。
- **影响**：pixi chunk ~700KB（gzip 后进入预算内）；升级 pixi 或接入更多依赖时保留该约束。

## D-008 · manifest URL 不带 assets/ 前缀

- **日期**：2026-08-20
- **决策**：资源逻辑名映射为 `bg/…`、`sprites/…`、`bgm/…` 等**根相对** URL，而非 `assets/bg/…`。
- **理由**：`publicDir:'assets'` 把 assets 目录**内容**复制到站点根（`dist/bg/…`），带前缀的 URL 会 404。
- **影响**：若未来改为构建期 emitFile + 内容哈希（M3 资产管线），URL 生成处统一收口在 `scanManifest`。

## D-009 · 输入推进的 busy 门控（过渡期忽略输入）

- **日期**：2026-08-20
- **决策**：`onAdvance` 在 loop 过渡期（block 已设置但 handleEvents/资源加载未完成，`busy === true`）忽略推进输入；推进动作先将 `block` 置 null 再执行。
- **理由**：E2E 破坏性测试暴露的竞态——过渡期二次按键会二次 `finishDialogue/finishWait` 使 pc 跳步（跳过 call 指令 → `@return` 报错），且 block 悬空造成永久死锁。忽略输入 vs 排队输入：M1 引入 Auto/Skip 时再升级为 pending-advance 队列。
- **影响**：极快连点可能"吃掉"一次点击（体验上表现为需要再点一次）；文本行显示路径（非过渡期）不受影响。
