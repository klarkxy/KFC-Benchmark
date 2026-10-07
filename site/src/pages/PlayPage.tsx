import { useEffect, useState } from "react";
import { formatMinor, formatPercent, formatSimMs } from "../lib/format";
import { DIFFICULTY_LABELS } from "../lib/labels";
import { readBest, loadScenarioIndex, type ScenarioSummary } from "../lib/scenarios";
import { href } from "../router";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; scenarios: ScenarioSummary[]; bests: Record<string, number> };

export function PlayPage(): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const index = await loadScenarioIndex();
        if (cancelled) return;
        const bests: Record<string, number> = {};
        for (const summary of index.scenarios) {
          const best = readBest(summary.tier);
          if (best !== null) bests[summary.tier] = best;
        }
        setState({ status: "ready", scenarios: index.scenarios, bests });
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return <section className="panel notice">正在读取场景列表 …</section>;
  }
  if (state.status === "error") {
    return (
      <section className="panel notice error">
        <p>无法加载场景：{state.message}</p>
        <p className="muted">
          本地开发请先运行 <code>pnpm exec tsx site/scripts/gen-scenarios.mts</code> 生成
          <code> site/public/scenarios/</code> 下的场景包。
        </p>
      </section>
    );
  }

  return (
    <section className="stack">
      <div className="replay-head">
        <div>
          <h2>试玩厨房</h2>
          <p className="muted small">
            浏览器里跑的是与榜单同一套确定性内核（<code>@kitchensched/game</code>
            逐步提交决策）：你是排程员，决定什么时候开什么工、交付哪一单。
            试玩成绩只存在你自己的浏览器里，不进榜单。
          </p>
        </div>
        <a className="muted small" href={href("/")}>
          ← 返回榜单
        </a>
      </div>

      <section className="panel">
        <h3>怎么玩</h3>
        <ol className="how-to-list">
          <li>目标——5 分钟营业时间内交付尽量多订单，只赚整单交付的钱。</li>
          <li>循环——开工生产（配方 / 工位 / 批次）→ 推进时间 → 库存够了就交付。</li>
          <li>订单不会过期，账面达成率与贪心 bot 参考分是你的及格线。</li>
        </ol>
        <p className="muted small">提示：焦点不在任何控件上时，按空格或回车 = 推进时间。</p>
      </section>

      {state.scenarios.length === 0 ? (
        <section className="panel notice">暂无可玩场景。</section>
      ) : (
        <div className="scenario-grid">
          {state.scenarios.map((summary) => {
            const best = state.bests[summary.tier];
            const beatGreedy =
              best !== undefined && summary.greedy_score_minor > 0
                ? best >= summary.greedy_score_minor
                : null;
            return (
              <a className="panel scenario-card" key={summary.tier} href={href(`/play/${summary.tier}`)}>
                <div className="scenario-card-head">
                  <h3>{summary.label}</h3>
                  <span className="badge difficulty">{DIFFICULTY_LABELS[summary.difficulty] ?? summary.difficulty}</span>
                </div>
                <dl className="kv">
                  <dt>订单数</dt>
                  <dd>{summary.order_count}</dd>
                  <dt>工位数</dt>
                  <dd>{summary.station_count}</dd>
                  <dt>营业时长</dt>
                  <dd>{formatSimMs(summary.end_at_ms)}</dd>
                  <dt>账面总额</dt>
                  <dd className="money">{formatMinor(summary.book_value_minor)}</dd>
                  <dt>贪心 bot</dt>
                  <dd className="money">{formatMinor(summary.greedy_score_minor)}</dd>
                  <dt>你的最好成绩</dt>
                  <dd className="money">
                    {best === undefined ? (
                      <span className="muted">尚无记录</span>
                    ) : (
                      <>
                        {formatMinor(best)}
                        {beatGreedy === true ? <span className="pill good">已超过 bot</span> : null}
                      </>
                    )}
                  </dd>
                  <dt>账面达成</dt>
                  <dd>{formatPercent(summary.greedy_score_minor, summary.book_value_minor)}（bot）</dd>
                </dl>
                <span className="scenario-cta">进入厨房 →</span>
              </a>
            );
          })}
        </div>
      )}
    </section>
  );
}
