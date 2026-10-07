# KitchenSched 提交契约（protocol 0.3.0-web）

> 第一阶段赛道：TypeScript 单文件控制器。语义与文档 02/03 的 0.2.0
> 完全一致，仅传输层从 stdin/stdout JSONL 改为模块函数调用。

## 交付物

`submissions/<model_label>/gen-<N>/submission.ts` —— 单文件、无运行时依赖、
default export 满足：

```ts
import type { ControllerModule } from "@kitchensched/contracts";

const controller: ControllerModule = {
  init(config, ctx) {
    // config: 本局完整公开配置（物品/配方/设备/截止/limits）
    // ctx.policy_seed + ctx.random(): 确定性随机源，禁止用 Math.random()
  },
  decide(observation) {
    // 世界在本函数执行期间暂停（paused_code），真实 wall-clock 预算生效
    return { actions: [], wake_at_ms: null };
  },
};

export default controller;
```

## 动作

- `start`：{ type, action_id, recipe_id, station_id, batches, input_lots }
  批量在 1..max_batches 内耗时固定；produced 输入按品项聚合后必须恰好满足配方；
  unlimited_raw 无需 lot 引用。
- `deliver`：{ type, action_id, order_id, output_lots }
  一次性满足整单；部分交付/替代/重复交付均无收入。
- 同一 decide 返回的多个 action 按数组顺序逐个原子执行，后面能看到前面
  已成功扣减的库存与设备占用。
- `wake_at_ms` 必填：null 清除待触发唤醒；合法值（≥ now+min_wake_delay 且
  ≤ end_at）替换之；非法值只拒绝唤醒更新，不影响同批合法动作。

## 语义要点（与 0.2.0 相同）

- t=0 无条件首次 observe；订单 arrival < end_at；t=end_at 时先结算恰好完成的
  任务产出，再给一次 final=true 的 observe（只允许 deliver），随后立即结算。
- action_id 整局唯一；相同 ID 相同内容返回原结果（replayed=true），不同内容
  返回 ACTION_ID_CONFLICT；失败也缓存，重试换新 ID。
- 唯一主分：score_minor = 截止前有效整单交付金额之和（整数最小计价单位）。
- 业务错误码：UNKNOWN_RECIPE / UNKNOWN_STATION / INCOMPATIBLE_STATION /
  STATION_BUSY / INVALID_BATCH / UNKNOWN_LOT / DUPLICATE_LOT / INVALID_INPUT /
  INSUFFICIENT_INPUT / UNKNOWN_ORDER / INCOMPLETE_ORDER / ALREADY_DELIVERED /
  ACTION_ID_CONFLICT / DEADLINE_REACHED；唤醒错误 INVALID_WAKE_TIME。

## 硬性约束（提交审查清单）

1. 单文件，无 import（`import type` 除外）；
2. 无网络、无定时器、无 `Date.now()/performance.now()/Math.random()`——
   宿主已把这些钉死，但显式使用视为违规；
3. 无混淆代码；
4. 不得硬编码订单轨迹（计分轨迹由 CI 私有种子生成，硬编码练习轨迹无意义）；
5. `decide` 必须同步返回，不得保存上一次调用后仍在运行的异步任务。

## 失败计分

结构错误（返回值不合法、异常抛出、超时、超预算）→ candidate_failed，
官方 score_minor = 0。基础设施故障 → score_minor = null，补跑。
