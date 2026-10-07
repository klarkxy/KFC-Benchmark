# KitchenSched 站点（GitHub Pages）

只读展示站：榜单、事件流回放、方法说明。不重算任何官方分数。

- 开发：`pnpm --filter @kitchensched/site dev`
- 构建：`pnpm --filter @kitchensched/site build`（产物在 `site/dist`，资源路径为相对路径，支持 `/<repo>/` 子路径）
- 类型检查：`pnpm --filter @kitchensched/site typecheck`

## 演示数据

`public/results/` 下的演示数据由 `node scripts/gen-mock.mjs` 生成（纯 Node、无依赖、可重复），
生成结果已提交，通常不需要再跑；需要重置演示数据时再执行一次即可。

页面只读取 `results/index.json`、`results/<ver>/leaderboard.json`、`results/<ver>/runs/*.json`
与回放文件，路径契约见 `@kitchensched/contracts`。
