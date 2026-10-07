import { useEffect, useMemo, useState } from "react";
import type { Difficulty, LeaderboardRow, ResultsIndex, RunRecord } from "@kitchensched/contracts";
import { formatMinor, formatPercent, shortHash } from "../lib/format";
import { DIFFICULTY_LABELS } from "../lib/labels";
import { latestVersion, loadIndex, loadLeaderboard, loadRun } from "../lib/results";
import { href } from "../router";

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "complex"];
const MAX_RUN_LOOKUPS = 120;

/** First run of the row that has a published replay, or null. */
function replayTargetFor(row: LeaderboardRow, runs: Readonly<Record<string, RunRecord>>): string | null {
  for (const runId of row.run_ids) {
    const run = runs[runId];
    if (run?.replay) return runId;
  }
  return null;
}

function sortedVersions(index: ResultsIndex): ResultsIndex["versions"] {
  return [...index.versions].sort((a, b) =>
    a.published_at_iso < b.published_at_iso ? 1 : a.published_at_iso > b.published_at_iso ? -1 : 0,
  );
}

export function LeaderboardPage(): JSX.Element {
  const [index, setIndex] = useState<ResultsIndex | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [versionName, setVersionName] = useState<string | null>(null);
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  const [runs, setRuns] = useState<Record<string, RunRecord>>({});

  // Load the results index once; default to the newest benchmark_version.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await loadIndex();
        if (cancelled) return;
        setIndex(loaded);
        setVersionName(latestVersion(loaded).benchmark_version);
      } catch (error) {
        if (!cancelled) setIndexError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Reload the leaderboard whenever the selected version changes.
  useEffect(() => {
    if (!index || !versionName) return;
    const entry = index.versions.find((v) => v.benchmark_version === versionName);
    if (!entry) return;
    let cancelled = false;
    setRows(null);
    setBoardError(null);
    setRuns({});
    (async () => {
      try {
        const leaderboard = await loadLeaderboard(entry);
        if (!cancelled) setRows(leaderboard.rows);
      } catch (error) {
        if (!cancelled) setBoardError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [index, versionName]);

  // A row links to its first published replay, which is only visible on the
  // RunRecord. Resolve the referenced run files once per leaderboard load.
  useEffect(() => {
    if (!rows || !versionName) return;
    let cancelled = false;
    const runIds = [...new Set(rows.flatMap((row) => row.run_ids))].slice(0, MAX_RUN_LOOKUPS);
    (async () => {
      const collected: Record<string, RunRecord> = {};
      for (let cursor = 0; cursor < runIds.length; cursor += 6) {
        const batch = runIds.slice(cursor, cursor + 6);
        const settled = await Promise.allSettled(
          batch.map((runId) => loadRun(versionName, runId)),
        );
        settled.forEach((result, position) => {
          const runId = batch[position];
          if (runId && result.status === "fulfilled") collected[runId] = result.value;
        });
        if (cancelled) return;
      }
      if (!cancelled) setRuns(collected);
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, versionName]);

  const rowsByDifficulty = useMemo(() => {
    const grouped = new Map<Difficulty, LeaderboardRow[]>();
    for (const item of DIFFICULTIES) grouped.set(item, []);
    for (const row of rows ?? []) grouped.get(row.difficulty)?.push(row);
    return grouped;
  }, [rows]);

  if (indexError) {
    return (
      <section className="panel notice error">
        <p>无法加载排行榜数据:{indexError}</p>
        <p className="muted">
          本地开发请先运行 <code>node scripts/gen-mock.mjs</code> 生成 site/public/results/ 下的演示数据。
        </p>
      </section>
    );
  }
  if (!index || !versionName) {
    return <section className="panel notice">正在读取 results/index.json …</section>;
  }

  const versions = sortedVersions(index);
  const activeRows = rowsByDifficulty.get(difficulty) ?? [];

  return (
    <section className="stack">
      <div className="tabs" role="tablist" aria-label="数据版本">
        {versions.map((entry) => (
          <button
            key={entry.benchmark_version}
            type="button"
            role="tab"
            aria-selected={entry.benchmark_version === versionName}
            className={entry.benchmark_version === versionName ? "tab active" : "tab"}
            onClick={() => setVersionName(entry.benchmark_version)}
          >
            {entry.benchmark_version}
          </button>
        ))}
      </div>

      <div className="leaderboard-meta">
        <div>
          <span className="label">发布于</span>
          <code>{versions.find((v) => v.benchmark_version === versionName)?.published_at_iso}</code>
        </div>
        <span className="badge warn">演示榜 · 非官方 harness</span>
      </div>

      <div className="tabs" role="tablist" aria-label="难度">
        {DIFFICULTIES.map((item) => {
          const count = rowsByDifficulty.get(item)?.length ?? 0;
          return (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={item === difficulty}
              className={item === difficulty ? "tab active" : "tab"}
              onClick={() => setDifficulty(item)}
            >
              {DIFFICULTY_LABELS[item]} <span className="muted">({count})</span>
            </button>
          );
        })}
      </div>

      {boardError ? (
        <section className="panel notice error">无法加载 {versionName} 的榜单：{boardError}</section>
      ) : rows === null ? (
        <section className="panel notice">正在读取 {versionName} 的榜单 …</section>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>模型</th>
              <th className="num">生成序号</th>
              <th className="num">平均分</th>
              <th className="num">完成</th>
              <th className="num">失败</th>
              <th className="num">补跑中</th>
              <th className="num">用例数</th>
              <th>源码哈希</th>
              <th>回放</th>
            </tr>
          </thead>
          <tbody>
            {activeRows.length === 0 ? (
              <tr>
                <td colSpan={9} className="muted">
                  该难度下暂无数据。
                </td>
              </tr>
            ) : (
              activeRows.map((row) => {
                const target = replayTargetFor(row, runs);
                const total = row.cases;
                return (
                  <tr key={`${row.submission.submission_id}-${row.difficulty}`}>
                    <td className="model">{row.submission.model_label}</td>
                    <td className="num">#{row.submission.generation}</td>
                    <td className="num money">
                      {formatMinor(row.mean_score_minor)}
                      {row.mean_score_minor !== null && (
                        <span className="muted small"> {row.mean_score_minor}</span>
                      )}
                    </td>
                    <td className="num">
                      {row.completed}
                      <span className="muted small"> {formatPercent(row.completed, total)}</span>
                    </td>
                    <td className="num">
                      {row.candidate_failed}
                      <span className="muted small">
                        {" "}
                        {formatPercent(row.candidate_failed, total)}
                      </span>
                    </td>
                    <td className="num">
                      {row.infra_failed}
                      <span className="muted small">
                        {" "}
                        {formatPercent(row.infra_failed, total)}
                      </span>
                    </td>
                    <td className="num">{total}</td>
                    <td>
                      <code title={row.submission.source_sha256}>
                        {shortHash(row.submission.source_sha256)}
                      </code>
                    </td>
                    <td>
                      {target ? (
                        <a
                          className="replay-link"
                          href={href(
                            `/replay/${encodeURIComponent(versionName)}/${encodeURIComponent(target)}`,
                          )}
                        >
                          回放
                        </a>
                      ) : (
                        <span className="muted">无</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      )}

      <p className="muted small">
        分数为整数 credit_minor（表格内已按 <code>(v/100).toFixed(2)</code> 显示，
        灰色为原始整数）。点击行内「回放」打开该行第一个已发布回放的 run；
        显示「无」的版本（如 sealed 计分榜）按规则不公开回放。
        「补跑中」为 infra_failed：基础设施异常导致的重跑，不计入平均分。
      </p>
    </section>
  );
}
