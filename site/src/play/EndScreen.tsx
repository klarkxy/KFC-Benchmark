import { useEffect, useState } from "react";
import type { RunOutput } from "@kitchensched/game";

import { formatMinor, formatPercent } from "../lib/format";
import { DIFFICULTY_LABELS, STATUS_LABELS } from "../lib/labels";
import type { ScenarioBundle } from "../lib/scenarios";
import { href } from "../router";
import { COIN } from "./icons";
import { releaseFocus } from "./interaction";

/**
 * 打烊结算. Same numbers as the run actually produced (the kernel's
 * RunOutput), dressed as a shift report: a tally that counts up, a medal, and
 * the same three exits as before.
 */

export interface EndScreenProps {
  bundle: ScenarioBundle;
  done: RunOutput;
  best: number | null;
  isRecord: boolean;
  onRestart: () => void;
  onDownload: () => void;
}

/** Bar length against the day's full book, so both rows share one scale. */
function barWidth(value: number | null, book: number): number {
  if (value === null || book <= 0) return 0;
  return Math.max(2, Math.min(100, (value / book) * 100));
}

/** 🏆 perfect day, 🥇 beat the bot, 🥈 half the book, 🥉 a rough shift. */

export function medalFor(score: number | null, book: number, greedy: number): { icon: string; text: string } {
  if (score === null || book <= 0) return { icon: "🥉", text: "今天颗粒无收" };
  const ratio = score / book;
  if (ratio >= 1) return { icon: "🏆", text: "满堂彩！一单不落" };
  if (greedy > 0 && score >= greedy) return { icon: "🥇", text: "打败贪心 bot" };
  if (ratio >= 0.5) return { icon: "🥈", text: "半数账面拿下" };
  return { icon: "🥉", text: "再练一把" };
}

/** Counts 0 → target so the payout feels earned. Reduced motion: instant. */
function useTally(target: number | null): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (target === null) {
      setValue(0);
      return;
    }
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || target === 0) {
      setValue(target);
      return;
    }
    const from = 0;
    const started = performance.now();
    const span = 900;
    let frame = 0;
    const tick = (now: number): void => {
      const ratio = Math.min(1, (now - started) / span);
      const eased = 1 - (1 - ratio) ** 3;
      setValue(Math.round(from + (target - from) * eased));
      if (ratio < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return value;
}

export function EndScreen({
  bundle,
  done,
  best,
  isRecord,
  onRestart,
  onDownload,
}: EndScreenProps): JSX.Element {
  const { result } = done;
  const book = bundle.reference.book_value_minor;
  const greedy = bundle.reference.greedy_score_minor;
  const score = result.score_minor;
  const tally = useTally(score);
  const medal = medalFor(score, book, greedy);
  const delta = score === null ? null : score - greedy;

  return (
    <section className="play-root k-end" aria-label="打烊结算">
      <div className="k-end-card">
        <span className="k-end-medal" aria-hidden="true">
          {medal.icon}
        </span>
        <h2>打烊！</h2>
        <p className="k-muted">{medal.text}</p>

        <div className="k-end-score">
          <span className="k-display">{formatMinor(tally)}</span>
          {isRecord ? <span className="k-stamp new">🏅 新纪录</span> : null}
        </div>
        <p className="k-muted small">
          {COIN} 账面 {formatMinor(book)} · 达成 {score === null ? "—" : formatPercent(score, book)}
        </p>

        <div className="k-race" aria-label="与贪心 bot 的对比">
          <div className="k-race-row">
            <span className="k-race-name">你</span>
            <div className="k-race-bar">
              <i className="is-you" style={{ width: `${barWidth(score, book)}%` }} />
            </div>
            <b className="k-race-value">{formatMinor(score)}</b>
          </div>
          <div className="k-race-row">
            <span className="k-race-name">贪心 bot</span>
            <div className="k-race-bar">
              <i className="is-bot" style={{ width: `${barWidth(greedy, book)}%` }} />
            </div>
            <b className="k-race-value">{formatMinor(greedy)}</b>
          </div>
          <p className="k-race-delta">
            {delta === null
              ? "今天颗粒无收"
              : delta >= 0
                ? `你比 bot 多赚了 ${formatMinor(Math.abs(delta))}`
                : `比 bot 少赚 ${formatMinor(Math.abs(delta))}`}
          </p>
        </div>

        <ul className="k-end-rows">
          <li>
            <span>难度</span>
            <b>{DIFFICULTY_LABELS[bundle.config.difficulty] ?? bundle.config.difficulty}</b>
          </li>
          <li>
            <span>状态</span>
            <b>{STATUS_LABELS[result.status] ?? result.status}</b>
          </li>
          <li>
            <span>营收</span>
            <b>{formatMinor(result.revenue_minor)}</b>
          </li>
          <li>
            <span>已交付订单</span>
            <b>{result.delivered_orders}</b>
          </li>
          <li>
            <span>贪心 bot</span>
            <b>
              {formatMinor(greedy)}
              {delta === null ? null : delta >= 0 ? (
                <span className="k-delta is-good"> 超过 {formatMinor(Math.abs(delta))}</span>
              ) : (
                <span className="k-delta is-bad"> 落后 {formatMinor(Math.abs(delta))}</span>
              )}
            </b>
          </li>
          <li>
            <span>本机最好</span>
            <b>{best === null ? "—" : formatMinor(best)}</b>
          </li>
          <li>
            <span>决策 / 动作</span>
            <b>
              {done.stats.decisions} / {done.stats.totalActions}
            </b>
          </li>
        </ul>

        <div className="k-end-actions">
          <button
            type="button"
            className="k-cta big"
            onClick={(event) => {
              releaseFocus(event);
              onRestart();
            }}
          >
            再来一局
          </button>
          <a className="k-cta ghost" href={href("/play")}>
            换场景
          </a>
          <button
            type="button"
            className="k-cta ghost"
            onClick={(event) => {
              releaseFocus(event);
              onDownload();
            }}
          >
            下载回放 JSON
          </button>
        </div>

        <p className="k-muted small">
          回放与榜单同格式（<code>replay_kind: human</code>）。本机成绩只写进浏览器，不上传。
        </p>
      </div>
    </section>
  );
}
