import { useEffect, useMemo, useRef, useState } from "react";
import type { RunRecord } from "@kitchensched/contracts";
import { formatMinor, formatSimMs } from "../lib/format";
import { DIFFICULTY_LABELS, STATUS_LABELS } from "../lib/labels";
import { loadIndex, loadReplay, loadRun, resolveRun, type ReplayFileData } from "../lib/results";
import { ReplayCanvas } from "../replay/ReplayCanvas";
import { describeEvent } from "../replay/describe";
import { inventoryOf, ReplayCursor } from "../replay/reducer";
import { href } from "../router";

const SPEEDS = [0.5, 1, 2, 4] as const;
const LOG_LIMIT = 60;

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "no-replay"; run: RunRecord }
  | { status: "ready"; run: RunRecord; replay: ReplayFileData };

export function ReplayPage({
  runId,
  version,
}: {
  runId: string;
  version?: string | undefined;
}): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [cursorMs, setCursorMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [cursor, setCursor] = useState<ReplayCursor | null>(null);
  const cursorMsRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      try {
        // Version-qualified links (from the leaderboard) load the run
        // directly; bare legacy links probe every published version.
        const run = version
          ? await loadRun(version, runId)
          : (await resolveRun(await loadIndex(), runId)).run;
        if (cancelled) return;
        if (!run.replay) {
          setState({ status: "no-replay", run });
          return;
        }
        const replay = await loadReplay(run);
        if (cancelled) return;
        setState({ status: "ready", run, replay });
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
  }, [runId, version]);

  // One cursor per replay: forward seeks fold incrementally, backward seeks
  // rebuild from event 0 (no checkpoints in phase 1).
  useEffect(() => {
    if (state.status !== "ready") return;
    setCursor(new ReplayCursor(state.replay.events));
    cursorMsRef.current = 0;
    setCursorMs(0);
    setPlaying(false);
  }, [state]);

  const folded =
    state.status === "ready" && cursor ? cursor.seek(cursorMs) : null;

  useEffect(() => {
    if (!playing || !cursor) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number): void => {
      const delta = (now - previous) * speed;
      previous = now;
      const next = Math.min(cursorMsRef.current + delta, cursor.durationMs);
      cursorMsRef.current = next;
      setCursorMs(next);
      if (next >= cursor.durationMs) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, cursor]);

  const seekTo = (next: number): void => {
    const clamped = Math.max(0, Math.min(next, cursor?.durationMs ?? 0));
    cursorMsRef.current = clamped;
    setCursorMs(clamped);
  };

  const appliedEvents = useMemo(() => {
    if (state.status !== "ready" || !cursor) return [];
    return state.replay.events
      .filter((event) => event.seq <= (folded?.eventsApplied ?? 0))
      .slice(-LOG_LIMIT)
      .reverse();
  }, [state, cursor, folded]);

  if (state.status === "loading") {
    return <section className="panel notice">正在读取 run {runId} …</section>;
  }
  if (state.status === "error") {
    return (
      <section className="panel notice error">
        <p>无法加载 run：{state.message}</p>
        <p className="muted">
          <a href={href("/")}>返回榜单</a>
        </p>
      </section>
    );
  }
  if (state.status === "no-replay") {
    return (
      <section className="panel notice">
        <p>run {runId} 未发布回放（replay = null）。</p>
        <p className="muted">
          <a href={href("/")}>返回榜单</a>
        </p>
      </section>
    );
  }

  const { run, replay } = state;
  const duration = cursor?.durationMs ?? 0;
  const progress = duration > 0 ? cursorMs / duration : 0;

  return (
    <section className="stack">
      <div className="replay-head">
        <div>
          <h2>
            {run.submission.model_label} <span className="muted">#{run.submission.generation}</span>
          </h2>
          <p className="muted small">
            run <code>{run.run_id}</code> · {DIFFICULTY_LABELS[run.difficulty] ?? run.difficulty} ·{" "}
            {STATUS_LABELS[run.result.status] ?? run.result.status} · 得分{" "}
            <strong className="money">{formatMinor(run.result.score_minor)}</strong> credit
          </p>
        </div>
        <a className="muted small" href={href("/")}>
          ← 返回榜单
        </a>
      </div>

      <div className="replay-layout">
        <div className="stack">
          <div className="panel canvas-panel">
            {folded ? <ReplayCanvas state={folded} /> : null}
          </div>

          <div className="controls">
            <button
              type="button"
              className="button primary"
              onClick={() => {
                if (cursorMs >= duration) seekTo(0);
                setPlaying((current) => !current);
              }}
              disabled={!cursor}
            >
              {playing ? "暂停" : cursorMs >= duration && duration > 0 ? "重播" : "播放"}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setPlaying(false);
                seekTo(0);
              }}
            >
              回到起点
            </button>
            <div className="speeds" role="group" aria-label="播放速度">
              {SPEEDS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={value === speed ? "chip active" : "chip"}
                  onClick={() => setSpeed(value)}
                >
                  {value}×
                </button>
              ))}
            </div>
            <input
              className="scrubber"
              type="range"
              min={0}
              max={Math.max(duration, 1)}
              step={50}
              value={cursorMs}
              onChange={(event) => {
                setPlaying(false);
                seekTo(Number(event.target.value));
              }}
              aria-label="回放进度"
            />
            <span className="mono small">
              {formatSimMs(cursorMs)} / {formatSimMs(duration)}（{Math.round(progress * 100)}%）
            </span>
          </div>

          <p className="muted small">
            本地按事件流重建状态：只消费 <code>EventRecord</code>，不重新执行任何候选代码。
            时间游标向后拖动时会从第 0 个事件重放（第一阶段无检查点，reducer 保持纯函数以便后续接入）。
          </p>
        </div>

        <aside className="stack side">
          <div className="panel">
            <h3>运行结果</h3>
            <dl className="kv">
              <dt>营收</dt>
              <dd className="money">{formatMinor(run.result.revenue_minor)}</dd>
              <dt>已交付订单</dt>
              <dd>{run.result.delivered_orders}</dd>
              <dt>state_hash</dt>
              <dd>
                <code className="wrap" title={run.state_hash}>
                  {run.state_hash.slice(0, 16)}…
                </code>
              </dd>
              <dt>scenario</dt>
              <dd>
                <code className="wrap">{run.scenario_id}</code>
              </dd>
              <dt>决策 / 动作</dt>
              <dd>
                {run.wall.decisions} / {run.wall.total_actions}
              </dd>
              <dt>耗时</dt>
              <dd>{run.wall.duration_ms} ms</dd>
            </dl>
          </div>

          <div className="panel">
            <h3>回放头</h3>
            <dl className="kv">
              <dt>engine</dt>
              <dd>{replay.header.engine_version}</dd>
              <dt>protocol</dt>
              <dd>{replay.header.protocol_version}</dd>
              <dt>benchmark</dt>
              <dd>{replay.header.benchmark_version}</dd>
              <dt>种类</dt>
              <dd>{replay.header.replay_kind}</dd>
              <dt>时钟</dt>
              <dd>{replay.header.clock_mode}</dd>
              <dt>订单流</dt>
              <dd>
                {replay.header.order_stream.visibility}
                {replay.header.order_stream.seed !== undefined &&
                  ` · seed ${replay.header.order_stream.seed}`}
              </dd>
              <dt>事件数</dt>
              <dd>
                {folded?.eventsApplied ?? 0} / {replay.events.length}
              </dd>
            </dl>
            <p className="muted small">
              state_hash 校验值：<code className="wrap">{run.state_hash}</code>
            </p>
          </div>

          {folded ? (
            <div className="panel">
              <h3>库存快照</h3>
              <ul className="plain">
                {inventoryOf(folded).length === 0 ? (
                  <li className="muted">无在库成品</li>
                ) : (
                  inventoryOf(folded).map((entry) => (
                    <li key={entry.item_id}>
                      <code>{entry.item_id}</code>
                      <span className="money"> ×{entry.quantity}</span>
                    </li>
                  ))
                )}
              </ul>
            </div>
          ) : null}

          <div className="panel">
            <h3>事件流</h3>
            <ol className="log">
              {appliedEvents.length === 0 ? (
                <li className="muted">拖动进度条或点击播放。</li>
              ) : (
                appliedEvents.map((event) => (
                  <li key={event.seq}>
                    <button type="button" className="log-row" onClick={() => seekTo(event.at_ms)}>
                      <span className="mono muted">#{event.seq}</span>
                      <span className="mono muted">{formatSimMs(event.at_ms)}</span>
                      <span className="log-type">{event.type}</span>
                      <span className="log-text">{describeEvent(event)}</span>
                    </button>
                  </li>
                ))
              )}
            </ol>
          </div>
        </aside>
      </div>
    </section>
  );
}
