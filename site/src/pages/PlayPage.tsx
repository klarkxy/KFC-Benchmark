import { useEffect, useState } from "react";
import { formatMinor, formatPercent, formatSimMs } from "../lib/format";
import { DIFFICULTY_LABELS } from "../lib/labels";
import { readBest, loadScenarioIndex, type ScenarioSummary } from "../lib/scenarios";
import { href } from "../router";
import { COIN } from "../play/icons";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; scenarios: ScenarioSummary[]; bests: Record<string, number> };

const TIER_ART: Readonly<Record<string, string>> = {
  easy: "🍟",
  medium: "🌯",
  complex: "🍱",
};

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
    return <section className="play-root k-note">正在翻菜单 …</section>;
  }
  if (state.status === "error") {
    return (
      <section className="play-root k-note is-bad">
        <p>无法加载场景：{state.message}</p>
        <p className="k-muted">本地开发请先运行 pnpm exec tsx site/scripts/gen-scenarios.mts。</p>
      </section>
    );
  }

  return (
    <section className="play-root k-picker">
      <header className="k-picker-head">
        <div>
          <h1 className="k-title">
            <span aria-hidden="true">🍟</span> 试玩厨房
          </h1>
          <p className="k-muted">
            和榜单同一套确定性内核，只不过策略由你拍板。成绩只存在你的浏览器里，不进榜。
          </p>
        </div>
        <a className="k-cta ghost" href={href("/")}>
          ← 返回榜单
        </a>
      </header>

      <section className="k-howto" aria-label="怎么玩">
        <h2 className="k-side-title">怎么玩</h2>
        <ol className="k-howto-list">
          <li>目标——5 分钟内交付尽量多订单；只赚整单交付的钱，订单不会过期。</li>
          <li>点空闲工位就直接开工，系统自动挑当下最该做的配方；想换就点 ⋯、双击或长按。</li>
          <li>小票会自己飞进来，发亮的点一下就收钱；🔁 重复上一手，排错了去托盘 ✕ 取消。</li>
          <li>别输给贪心 bot —— 它的分数就在每张卡上。</li>
        </ol>
        <p className="k-muted small">键盘：空格 / 回车 = 暂停与继续。</p>
      </section>

      {state.scenarios.length === 0 ? (
        <p className="k-note">暂无可玩场景。</p>
      ) : (
        <div className="k-cards">
          {state.scenarios.map((summary) => {
            const best = state.bests[summary.tier];
            const beatGreedy =
              best !== undefined && summary.greedy_score_minor > 0
                ? best > summary.greedy_score_minor
                : null;
            return (
              <a className="k-card" key={summary.tier} href={href(`/play/${summary.tier}`)}>
                <div className="k-card-top">
                  <span className="k-card-art" aria-hidden="true">
                    {TIER_ART[summary.tier] ?? "🍽️"}
                  </span>
                  <div>
                    <h2 className="k-card-title">{summary.label}</h2>
                    <span className="k-tag">
                      {DIFFICULTY_LABELS[summary.difficulty] ?? summary.difficulty}
                    </span>
                  </div>
                </div>

                <ul className="k-card-stats">
                  <li>
                    <span>订单</span>
                    <b>{summary.order_count}</b>
                  </li>
                  <li>
                    <span>工位</span>
                    <b>{summary.station_count}</b>
                  </li>
                  <li>
                    <span>时长</span>
                    <b>{formatSimMs(summary.end_at_ms)}</b>
                  </li>
                </ul>

                <ul className="k-card-money">
                  <li>
                    <span>账面总额</span>
                    <b>{formatMinor(summary.book_value_minor)}</b>
                  </li>
                  <li>
                    <span>贪心 bot</span>
                    <b>
                      {COIN} {formatMinor(summary.greedy_score_minor)}
                    </b>
                  </li>
                  <li>
                    <span>你的最好成绩</span>
                    <b>
                      {best === undefined ? (
                        <span className="k-muted">尚无记录</span>
                      ) : (
                        <>
                          {formatMinor(best)}
                          {beatGreedy === true ? <span className="k-stamp new">已超过 bot</span> : null}
                        </>
                      )}
                    </b>
                  </li>
                </ul>

                <p className="k-muted small">
                  bot 账面达成率 {formatPercent(summary.greedy_score_minor, summary.book_value_minor)}
                  {" · "}scenario <code>{summary.scenario_id}</code>
                </p>

                <span className="k-cta wide">进入厨房 →</span>
              </a>
            );
          })}
        </div>
      )}
    </section>
  );
}
