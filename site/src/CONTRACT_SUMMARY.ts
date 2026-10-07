/**
 * Static Chinese copy for the methodology page. Kept as data so the wording is
 * reviewable in one place; the site renders it verbatim.
 */

export interface SummaryBlock {
  title: string;
  paragraphs: string[];
  bullets?: string[];
}

export interface SummarySection {
  id: string;
  heading: string;
  blocks: SummaryBlock[];
}

export const CONTRACT_SUMMARY: ReadonlyArray<SummarySection> = [
  {
    id: "goal",
    heading: "目标",
    blocks: [
      {
        title: "一句话",
        paragraphs: [
          "让模型为一家虚拟快餐店写排程控制器：在固定的仿真时间里，尽可能多地、按时地把订单送到顾客手里，把营收做到最高。",
        ],
      },
      {
        title: "流程",
        paragraphs: [
          "订单持续到达（prep → fry → assemble → deliver），工位是稀缺的共享资源，库存会占用，交付必须整单满足。",
        ],
        bullets: [
          "同时在制的任务越多，占用的工位越多，但也越早备货完成。",
          "过度备货会滞销并压低单位时间的可交付订单数。",
          "截止时刻（finish_at_deadline_counts）完成的交付同样计分。",
        ],
      },
    ],
  },
  {
    id: "protocol",
    heading: "协议 0.3.0-web",
    blocks: [
      {
        title: "候选程序形态",
        paragraphs: [
          "候选提交是单文件 TypeScript 模块，导出 init 与 decide 两个入口。宿主负责加载它，并按固定节奏把 Observation 交给 decide。",
        ],
        bullets: [
          "init(config)：接收静态 PublicConfig，初始化自己的状态。",
          "decide(observation)：返回本次要执行的动作列表，以及下一次唤醒的时间 wake_at_ms（必填，可为 null 表示不预约）。",
          "动作只有两类：start（开工单）和 deliver（交付整单）。",
        ],
      },
      {
        title: "时钟",
        paragraphs: [
          "clock 模式为 paused_code：仿真时间只在宿主推进时前进，候选代码看不到真实时间。",
        ],
      },
    ],
  },
  {
    id: "scoring",
    heading: "计分",
    blocks: [
      {
        title: "整数最小单位",
        paragraphs: [
          "所有金额都是整数 credit_minor，1 credit = 100 credit_minor；站点按 (v / 100).toFixed(2) 展示。",
          "结算方式为 whole_order：必须整单满足，不支持部分交付，也不支持取消。",
          "榜单均分按用例等权平均；同分保持同分，不做名次打破。",
        ],
      },
    ],
  },
  {
    id: "determinism",
    heading: "确定性",
    blocks: [
      {
        title: "固定订单流",
        paragraphs: [
          "评测流的订单由 CI secret 中的种子生成，种子与生成结果都不进仓库，因此正式评分无法被本地复现或针对性调参。",
          "练习流的订单流是 public 的，随仓库一起发布，任何人都能用相同种子重放。",
        ],
        bullets: [
          "回放文件头会标注 order_stream.visibility（public / sealed）与生成器版本。",
          "场景哈希、提交源码哈希、state_hash 一起构成可审计的三元组。",
        ],
      },
    ],
  },
  {
    id: "failure",
    heading: "失败计分",
    blocks: [
      {
        title: "两种失败",
        paragraphs: [
          "candidate_failed：候选程序自身的问题（超时、异常、非法动作超过上限等），记 0 分。",
          "infra_failed：基础设施或环境故障，属于待重跑的用例，mean_score_minor 记 null，该行不参与排名。",
        ],
      },
    ],
  },
  {
    id: "review",
    heading: "人工复核清单",
    blocks: [
      {
        title: "提交进入正式榜前逐条检查",
        paragraphs: ["任何一条不通过即退回或取消资格。"],
        bullets: [
          "单文件：只提交一个 TypeScript 模块，不依赖仓库其他文件。",
          "无网络：不允许发起任何网络请求。",
          "无 Math.random / Date.now：不允许读取随机数或真实时间。",
          "无混淆：不接受压缩、编码、动态求值等妨碍复核的写法。",
          "不硬编码轨迹：不得把某条评测轨迹的答案写死（例如按时间步查表输出动作）。",
        ],
      },
    ],
  },
];

export const PROTOCOL_VERSION = "0.3.0-web";
export const CURRENCY_NOTE =
  "分数单位为 credit_minor（整数，最小货币单位），站点按 (v/100).toFixed(2) 显示。";
