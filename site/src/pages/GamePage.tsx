import { useCallback, useEffect, useRef, useState } from "react";
import {
  createGameSession,
  serializeReplayFile,
  type EventRecord,
  type GameSession,
} from "@kitchensched/game";
import { formatMinor, formatSimMs } from "../lib/format";
import {
  loadScenarioBundle,
  loadScenarioIndex,
  orderStreamMeta,
  readBest,
  writeBest,
  type ScenarioBundle,
} from "../lib/scenarios";
import {
  applyEvent,
  createInitialState,
  seedStations,
  withCursor,
  type ReplayEvent,
  type ReplayState,
} from "../replay/reducer";
import { ReplayCanvas } from "../replay/ReplayCanvas";
import { href } from "../router";
import { Composer, type StagedAction } from "../play/composer";
import {
  EndPanel,
  FeedbackPanel,
  InventoryPanel,
  OrdersPanel,
  StagedPanel,
  StationsPanel,
  type Feedback,
} from "../play/panels";

/**
 * One human game: the real kernel paused between decisions.
 *
 * The kernel owns the world; this page owns two views of it. The canvas folds
 * the session's event stream with the same reducer the replay page uses, while
 * the decision panel reads the current observation directly. Both therefore
 * show the same kitchen — one drawn from events, one from the kernel's own
 * snapshot.
 */

type LoadState =
  | { status: "loading" }
  | { status: "unknown-tier"; tier: string }
  | { status: "error"; message: string }
  | { status: "ready"; bundle: ScenarioBundle; session: GameSession };

/**
 * `EventRecord` widens `payload` to a union; the wire format is the
 * distributive `ReplayEvent`. Re-narrowed once, here, at the same boundary
 * `lib/results.ts` uses for fetched replays.
 */
function asReplayEvents(events: readonly EventRecord[]): readonly ReplayEvent[] {
  return events as readonly ReplayEvent[];
}

/** Folds a whole session, seeding every station so the kitchen exists at t=0. */
function foldSession(session: GameSession, cursorMs: number): ReplayState {
  let state = seedStations(createInitialState(), session.config);
  for (const event of asReplayEvents(session.events)) state = applyEvent(state, event);
  return withCursor(state, cursorMs);
}

export function GamePage({ tier }: { tier: string }): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [round, setRound] = useState(0);
  const [folded, setFolded] = useState<ReplayState | null>(null);
  const [staged, setStaged] = useState<StagedAction[]>([]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [isRecord, setIsRecord] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setFolded(null);
    setStaged([]);
    setFeedback(null);
    setSubmitError(null);
    setIsRecord(false);
    setBest(null);
    (async () => {
      try {
        const index = await loadScenarioIndex();
        const summary = index.scenarios.find((entry) => entry.tier === tier);
        if (!summary) {
          if (!cancelled) setState({ status: "unknown-tier", tier });
          return;
        }
        const bundle = await loadScenarioBundle(summary);
        if (cancelled) return;
        const session = createGameSession({
          config: bundle.config,
          orders: bundle.orders,
          policy_seed: bundle.policy_seed,
        });
        setBest(readBest(bundle.tier));
        setFolded(foldSession(session, session.observation?.now_ms ?? 0));
        setState({ status: "ready", bundle, session });
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
  }, [tier, round]);

  const session = state.status === "ready" ? state.session : null;
  const done = session?.done ?? null;
  const observation = session?.observation ?? null;

  // The run is over exactly once: store the score and remember whether it beat
  // what this browser had recorded before.
  useEffect(() => {
    if (!done || state.status !== "ready") return;
    const score = done.result.score_minor;
    if (score === null) return;
    const previous = readBest(state.bundle.tier);
    const isNew = previous === null || score > previous;
    setIsRecord(isNew);
    setBest(writeBest(state.bundle.tier, score));
  }, [done, state]);

  const restart = useCallback(() => {
    setRound((value) => value + 1);
  }, []);

  const downloadReplay = useCallback(() => {
    if (!session || state.status !== "ready") return;
    const file = session.replayFile({
      benchmark_version: "play-v1",
      order_stream: orderStreamMeta(state.bundle),
    });
    const blob = new Blob([serializeReplayFile(file)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `kitchensched-replay-${state.bundle.tier}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [session, state]);

  const submit = useCallback((): void => {
    if (!session || !observation) return;
    const labels: Record<string, string> = {};
    for (const entry of staged) labels[entry.action.action_id] = entry.label;
    const result = session.submit({
      actions: staged.map((entry) => entry.action),
      wake_at_ms: null,
    });
    if (!result.ok) {
      setSubmitError(result.reason);
      return;
    }
    setSubmitError(null);
    setFolded((previous) => {
      if (!previous) return previous;
      let next = previous;
      for (const event of asReplayEvents(result.events)) next = applyEvent(next, event);
      return withCursor(next, result.observation ? result.observation.now_ms : next.nowMs);
    });
    setStaged([]);
    setResetKey((value) => value + 1);
    const nextObservation = result.observation;
    setFeedback({
      results: nextObservation
        ? nextObservation.previous_results
        : (result.done?.result.final_action_results ?? []),
      wake: nextObservation ? nextObservation.previous_wake_result : (result.done?.result.final_wake_result ?? null),
      labels,
    });
    // The session object never changes identity, but its getters do; force the
    // render that reads the new observation.
    setState((current) => (current.status === "ready" ? { ...current } : current));
  }, [session, observation, staged]);

  // Latest submit, so the key handler below can be registered exactly once.
  const submitRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  /**
   * Space / Enter = 推进时间 (or 结算), but only while nothing is focused: a
   * full easy run is ~670 clicks and a third of the decision points are bare
   * clock advances, so holding space is the natural way to run the line. Any
   * focused control — input, select, button, tab — keeps its native behavior.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.key !== " " && event.key !== "Enter") return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (document.activeElement !== document.body) return;
      event.preventDefault();
      submitRef.current?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (state.status === "loading") {
    return <section className="panel notice">正在准备场景 {tier} …</section>;
  }
  if (state.status === "unknown-tier") {
    return (
      <section className="panel notice error">
        <p>没有名为「{state.tier}」的场景。</p>
        <p className="muted">
          <a href={href("/play")}>← 返回场景列表</a>
        </p>
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section className="panel notice error">
        <p>无法加载场景：{state.message}</p>
        <p className="muted">
          本地开发请先运行 <code>pnpm exec tsx site/scripts/gen-scenarios.mts</code>。
        </p>
        <p className="muted">
          <a href={href("/play")}>← 返回场景列表</a>
        </p>
      </section>
    );
  }

  const { bundle } = state;
  const live = state.session;
  const nowMs = observation?.now_ms ?? bundle.config.end_at_ms;

  return (
    <section className="stack">
      <div className="replay-head">
        <div>
          <h2>
            {bundle.tier} <span className="muted">· {bundle.config.scenario_id}</span>
          </h2>
          <p className="muted small">
            营业时间 {formatSimMs(nowMs)} / {formatSimMs(bundle.config.end_at_ms)} · 营收{" "}
            <strong className="money">
              {formatMinor(observation?.revenue_minor ?? done?.result.revenue_minor ?? 0)}
            </strong>{" "}
            ·{" "}
            {observation ? `待交付 ${observation.orders.length} 单` : "已打烊"}
          </p>
        </div>
        <a className="muted small" href={href("/play")}>
          ← 换场景
        </a>
      </div>

      <div className="play-layout">
        <div className="stack">
          <div className="panel canvas-panel">
            {folded ? <ReplayCanvas state={folded} /> : null}
          </div>

          {done ? (
            <EndPanel
              bundle={bundle}
              done={done}
              best={best}
              isRecord={isRecord}
              onRestart={restart}
              onDownload={downloadReplay}
            />
          ) : observation ? (
            <StagedPanel
              staged={staged}
              isFinal={observation.final}
              submitError={submitError}
              onRemove={(actionId) =>
                setStaged((current) =>
                  current.filter((entry) => entry.action.action_id !== actionId),
                )
              }
              onClear={() => setStaged([])}
              onSubmit={submit}
            />
          ) : null}

          {observation ? (
            <>
              <Composer
                config={bundle.config}
                observation={observation}
                staged={staged}
                resetKey={resetKey}
                makeActionId={() => live.nextActionId()}
                onStage={(entry) => setStaged((current) => [...current, entry])}
              />
              <FeedbackPanel feedback={feedback} />
            </>
          ) : null}
        </div>

        {observation ? (
          <aside className="stack side">
            <OrdersPanel observation={observation} />
            <InventoryPanel observation={observation} nowMs={nowMs} />
            <StationsPanel observation={observation} />
          </aside>
        ) : null}
      </div>
    </section>
  );
}
