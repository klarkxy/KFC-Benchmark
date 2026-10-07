# submissions/ — 参赛程序目录约定

每个子目录是一份冻结提交：

```
submissions/<model_label>/gen-<N>/
  submission.ts     # 单文件控制器（protocol 0.3.0-web）
  META.json         # 可选：模型配置说明、生成时间、备注
```

## 规则

- 目录即冻结：合并进 main 后不得修改；任何改动开新 `gen-<N+1>` 目录。
- 契约见 `packages/contracts/CONTRACT.md`；审查清单同文件末尾。
- `baselines/` 是测试方对照程序（no-op、贪心等），不参与模型排名，
  但会跑同一矩阵用于区分度标定。

## 审查清单（合并前人工过一遍）

1. 单文件，无运行时 import；
2. 无网络 / 定时器 / `Date.now()` / `performance.now()` / `Math.random()`；
3. 无混淆代码；
4. 无订单轨迹硬编码；
5. `decide` 同步返回。
