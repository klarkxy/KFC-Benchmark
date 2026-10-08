import { useCallback, useEffect, useState } from "react";
import { createGameSession, serializeReplayFile, type GameSession } from "@kitchensched/game";

import {
  loadScenarioBundle,
  loadScenarioIndex,
  orderStreamMeta,
  readBest,
  writeBest,
  type ScenarioBundle,
} from "../lib/scenarios";
import { href } from "../router";
import { EndScreen } from "../play/EndScreen";
import { GameScreen } from "../play/GameView";
import { useGameFlow } from "../play/useGameFlow";

/**
 * One shift. The kernel stays the single source of truth and still pauses at
 * every decision point; `useGameFlow` decides *when* to ask it, and the clock
 * between two asks is a tween, not a turn.
 */

type LoadState =
  | { status: "loading" }
  | { status: "unknown-tier"; tier: string }
  | { status: "error"; message: string }
  | { status: "ready"; bundle: ScenarioBundle; session: GameSession };

export function GamePage({ tier }: { tier: string }): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [round, setRound] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [isRecord, setIsRecord] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setBest(null);
    setIsRecord(false);
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

  if (state.status === "loading") {
    return <section className="play-root k-note">正在开门 … 加载场景 {tier}</section>;
  }
  if (state.status === "unknown-tier") {
    return (
      <section className="play-root k-note is-bad">
        <p>没有名为「{state.tier}」的场景。</p>
        <p>
          <a href={href("/play")}>← 返回场景列表</a>
        </p>
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section className="play-root k-note is-bad">
        <p>无法加载场景：{state.message}</p>
        <p className="k-muted">本地开发请先运行 gen-scenarios 生成 site/public/scenarios/。</p>
        <p>
          <a href={href("/play")}>← 返回场景列表</a>
        </p>
      </section>
    );
  }

  return <Shift bundle={state.bundle} session={state.session} best={best} setBest={setBest} isRecord={isRecord} setIsRecord={setIsRecord} onRestart={() => setRound((value) => value + 1)} />;
}

function Shift({
  bundle,
  session,
  best,
  setBest,
  isRecord,
  setIsRecord,
  onRestart,
}: {
  bundle: ScenarioBundle;
  session: GameSession;
  best: number | null;
  setBest: (value: number | null) => void;
  isRecord: boolean;
  setIsRecord: (value: boolean) => void;
  onRestart: () => void;
}): JSX.Element {
  const flow = useGameFlow(session);
  const done = flow.done;

  // The shift is over exactly once: bank the score and note the record. A
  // scoreless shift is not a record — "🏅 新纪录" over 0.00 is just noise.
  useEffect(() => {
    if (!done) return;
    const score = done.result.score_minor;
    if (score === null) return;
    const previous = readBest(bundle.tier);
    setIsRecord(score > 0 && (previous === null || score > previous));
    setBest(writeBest(bundle.tier, score));
  }, [done, bundle, setBest, setIsRecord]);

  const downloadReplay = useCallback(() => {
    const file = session.replayFile({
      benchmark_version: "play-v1",
      order_stream: orderStreamMeta(bundle),
    });
    const blob = new Blob([serializeReplayFile(file)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `kitchensched-replay-${bundle.tier}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [bundle, session]);

  // Space toggles the flow while nothing is focused; focused controls keep
  // their native Enter/Space behavior.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.key !== " " && event.key !== "Enter") return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (document.activeElement !== document.body) return;
      event.preventDefault();
      flow.togglePause();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flow]);

  if (done) {
    return (
      <EndScreen
        bundle={bundle}
        done={done}
        best={best}
        isRecord={isRecord}
        onRestart={onRestart}
        onDownload={downloadReplay}
      />
    );
  }

  return (
    <GameScreen
      config={bundle.config}
      flow={flow}
      onExit={() => {
        window.location.hash = href("/play");
      }}
    />
  );
}
