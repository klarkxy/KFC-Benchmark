import { useEffect } from "react";
import { MethodologyPage } from "./pages/MethodologyPage";
import { LeaderboardPage } from "./pages/LeaderboardPage";
import { ReplayPage } from "./pages/ReplayPage";
import { GamePage } from "./pages/GamePage";
import { PlayPage } from "./pages/PlayPage";
import { DEFAULT_HASH, href, useRoute } from "./router";

function Header(): JSX.Element {
  return (
    <header className="topbar">
      <a className="brand" href={href("/")}>
        <span className="brand-mark" aria-hidden="true" />
        <span>
          KitchenSched <span className="muted">· LLM 厨房排程基准</span>
        </span>
      </a>
      <nav className="nav">
        <a href={href("/")}>榜单</a>
        <a href={href("/play")}>试玩</a>
        <a href={href("/methodology")}>方法</a>
      </nav>
    </header>
  );
}

export function App(): JSX.Element {
  const route = useRoute();

  useEffect(() => {
    if (!window.location.hash) window.location.hash = DEFAULT_HASH;
  }, []);

  return (
    <div className="app">
      <Header />
      <main className="content">
        {route.name === "leaderboard" ? <LeaderboardPage /> : null}
        {route.name === "replay" ? (
          <ReplayPage
            key={`${route.version ?? ""}/${route.runId}`}
            runId={route.runId}
            version={route.version}
          />
        ) : null}
        {route.name === "methodology" ? <MethodologyPage /> : null}
        {route.name === "play" && route.tier ? (
          <GamePage key={route.tier} tier={route.tier} />
        ) : null}
        {route.name === "play" && !route.tier ? <PlayPage /> : null}
      </main>
      <footer className="footer muted small">
        只读展示站：数据来自 CI 提交的 results/ 目录。演示数据 · 非官方 harness 结果。
      </footer>
    </div>
  );
}
