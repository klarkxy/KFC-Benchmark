# AGENTS.md

本仓库是 **KitchenSched（KFC-Benchmark）**：让 LLM 编写厨房调度程序，在统一、确定性的仿真中比拼实际成交总额（`score_minor`）的基准测试。

打开本文件的 agent 先判断自己的角色，然后只读对应的一节：

- **被测模型** —— 你的任务是编写/改进 `submissions/` 下的参赛控制器，提交本身即是被评测对象 → 读 [第一节](#一被测模型严格)。
- **开发模型** —— 你的任务是开发本仓库自身（内核、场景、站点、CI、工具链）→ 读 [第二节](#二开发模型)。

两节末尾的[共同纪律](#共同纪律)对所有人都适用。

---

## 一、被测模型（严格）

### 只有一次正式机会

- 每个模型版本只有 **一次正式计分机会**：一代一提交，正式成绩由 CI 用私有种子跑出，合入即冻结，**不可补交、不可覆盖、不可根据正式成绩回头改同一代**。
- 练习不受限：公开练习流随便跑、随便改（见下文「本地自测」）。正式提交之前，把练习能发现的 bug 全部消灭。
- 想再试一次的唯一合法方式是开新一代：`submissions/<model_label>/gen-<N+1>/`。历史 gen 目录原样保留，成为排行榜上的历史版本。

### 关键位置

| 你要找什么 | 在哪里 |
| --- | --- |
| 提交契约（**必读**，一切规则的权威文本） | `packages/contracts/CONTRACT.md` |
| 类型定义（Observation / Decision / Action / PublicConfig…） | `packages/contracts/src/types.ts` |
| 控制器接口（`ControllerModule`：init + decide） | `packages/contracts/src/controller.ts` |
| 提交落点 | `submissions/<model_label>/gen-<N>/submission.ts` |
| 参考实现：贪心基线 / 最小骨架 | `submissions/baselines/greedy/submission.ts`、`submissions/baselines/no-op/submission.ts` |
| 公开练习场景（配置 + 公开订单流） | `scenarios/<tier>/kitchen.json`、`scenarios/<tier>/practice-stream.json` |
| 仿真语义设计原文（Word） | `doc/02 仿真引擎与裁判规则.docx`、`doc/03 控制器协议与SDK.docx` |

### 本地自测（练习模式，不影响正式成绩）

```bash
pnpm install
pnpm -r build
pnpm score        # 公开练习流：公开种子、可复现；成绩不入官方榜
```

### 硬性约束（违反 = `candidate_failed`，官方成绩记 0）

1. 单文件 TypeScript，无运行时 import（`import type` 除外）；
2. 无网络、无定时器、无 `Date.now()` / `performance.now()` / `Math.random()`——随机性一律用 `ctx.random()`；
3. 无混淆代码；
4. 不得硬编码订单轨迹（正式计分用 CI 私有种子，硬编码练习轨迹毫无意义）；
5. `decide` 必须同步返回，不得残留异步任务。

细节一律以 `packages/contracts/CONTRACT.md` 为准；本文件不复述语义细则。

---

## 二、开发模型

### 仓库地图

| 路径 | 职责 |
| --- | --- |
| `packages/contracts` | 共享类型 + 提交契约 + canonical JSON + mulberry32 RNG。**纯包**，一切实现的依据，改动需全仓联动 |
| `packages/core` | 确定性内核：事件循环、start/deliver 事务、幂等、state_hash、裁判复核（`runScenario` / `verifyRun` / `Kernel`） |
| `packages/scen` | 场景与订单流生成器（种子确定性；calibration 内置） |
| `packages/host` | Node 运行器：加载 submission、跑用例矩阵、写 `results/`（**仅 Node**，浏览器包不得依赖） |
| `packages/game` | 浏览器内跑真实内核的真人游戏会话层（交互式步进，无 UI） |
| `site/` | GitHub Pages 静态站：榜单 `#/`、回放 `#/replay/[<version>/]<runId>`、方法页 `#/methodology`、试玩 `#/play` |
| `submissions/` | 参赛程序与 baselines；**冻结纪律**：改代码 = 新目录 |
| `scenarios/` | 公开练习场景（`pnpm gen:scenarios` 生成） |
| `results/` | CI 产出的官方成绩与回放，**站点唯一数据源**；由 CI bot 写入，不要手工编辑正式成绩 |
| `doc/` | 原始设计文档（Word）与机器可读契约包（v0.2/v0.3） |
| `.github/workflows/` | `score.yml`（计分 + 回写 results）与 `pages.yml`（构建部署站点，含 results 合并逻辑） |

### 常用命令

```bash
pnpm install
pnpm gen:scenarios                    # 重新生成公开练习场景
pnpm test                             # 全仓测试（vitest）
pnpm -r build                         # 全仓构建
pnpm score                            # 本地练习模式计分（开发用）
pnpm score -- --sealed --seed <N> --benchmark <V>   # 密封计分（CI 用）
pnpm --filter @kitchensched/site build      # 站点构建（产物 site/dist）
pnpm --filter @kitchensched/site typecheck
```

### 开发纪律（不可逾越）

- **确定性是生命线**：内核/场景路径禁止 `Math.random()`、`Date.now()`；随机性一律 `mulberry32(seed)`；相同输入必须产出逐字节相同的事件流与 `state_hash`。
- 金额/数量/时间一律整数；唯一主分 `score_minor`，同分并列。
- canonical JSON 序列化规则与 sha256 指纹算法不可改（`packages/contracts/src/canonical.ts`、`packages/core/src/hash.ts`）。
- **任何影响成绩的变更必须升 `benchmark_version`**，并在结果中以新版本区分。
- 计分轨迹由 CI secret 种子生成，不落盘、不进 git、不发回放；练习/演示流公开可复现。
- **浏览器可达的包（contracts / core / game / site）禁止引入 `node:*` 依赖**；Node-only 能力只能进 host / scen CLI。
- `results/` 的正式条目由 CI bot 提交；`results/index.json` 的 site-only 条目（如 demo-v1）由 `pages.yml` 在 overlay 时合并保留——改部署逻辑时不得弄丢。
- 站点数据契约：排行榜/回放页只消费 `results/` 与 `site/public/` 下的静态 JSON，字段名以 `packages/contracts/src/results.ts` 为准。

### 代码风格

- strict TypeScript；`site/` 开 `exactOptionalPropertyTypes`——可选 prop 传参要显式 `| undefined`。
- ESM everywhere；包内相对导入带 `.js` 后缀；各包统一 `tsc` 构建；`package.json` 的 `exports` 直接指向 `src/index.ts`——消费方（host CLI、site、脚本）经 tsx / Vite 直读 TS 源，plain Node 需先构建。
- 测试用 vitest，放在 `packages/<pkg>/tests/`；内核测试编号延续 atXX 惯例。
- Node 26 / pnpm 10；CI pin Node 24 + pnpm 10（注意版本差）。

---

## 共同纪律

- 不要向 git 提交密钥、CI 私有种子、或任何由私有种子派生的计分轨迹。
- `submissions/` 历史目录与 `results/` 历史成绩只增不改。
- 拿不准语义时，权威顺序：`packages/contracts/CONTRACT.md` → `doc/02`、`doc/03` → 内核测试。
