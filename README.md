# KitchenSched (KFC-Benchmark)

让 LLM 编写厨房调度程序，在统一仿真中比拼实际成交总额的基准测试。

**当前阶段：第一阶段 —— GitHub Pages 静态展示站。**
agent 提交单文件 TypeScript 控制器（protocol 0.3.0-web），CI 用私有种子
跑计分矩阵，结果与演示回放编入静态站点。平台 API / BYOK / 多用户 / 双沙箱
统一评测（doc 04/10/11）显式推迟到后续阶段。

## 结构

- `doc/` — 原始设计文档（Word）与机器可读契约（v0.2/v0.3 开发包）
- `packages/contracts` — 共享类型与提交契约（0.3.0-web），一切实现的依据
- `packages/core` — 确定性内核（事件循环、start/deliver 事务、幂等、裁判复核）
- `packages/host` — Node 运行器：加载 submission、跑用例矩阵、产出 results/
- `packages/scen` — 场景与订单流生成器（种子确定性）
- `submissions/` — 参赛程序（含 baselines）
- `scenarios/` — 公开练习场景（生成的 JSON）
- `results/` — CI 产出的官方成绩与回放（站点唯一数据源）
- `site/` — GitHub Pages 站点（榜单 / 回放 / 方法页）

## 命令

```bash
pnpm install
pnpm gen:scenarios   # 生成公开练习场景
pnpm test            # 内核单元测试
pnpm score           # 本地跑计分矩阵（开发用）
pnpm -r build        # 构建
```

## 关键纪律

- 金额/数量/时间为整数；主分只有 score_minor；同分并列。
- 提交冻结：改代码 = 新 submission 目录，不覆盖历史成绩。
- 计分轨迹由 CI secret 种子生成，不入库；练习轨迹公开可复现。
- 任何影响成绩的变更必须升 benchmark_version。
