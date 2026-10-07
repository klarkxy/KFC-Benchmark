import { fefoLots, type ActionResult, type Lot, type Observation, type WakeResult } from "@kitchensched/game";
import type { RunOutput } from "@kitchensched/game";
import { formatMinor, formatPercent, formatSimMs } from "../lib/format";
import { DIFFICULTY_LABELS, STATUS_LABELS, itemLabel, recipeLabel, stationLabel } from "../lib/labels";
import type { ScenarioBundle } from "../lib/scenarios";
import { href } from "../router";
import { actionCodeReason, wakeCodeReason } from "./reasons";
import type { StagedAction } from "./composer";
import { taskProgress } from "../replay/reducer";

/**
 * Read-only panels of the play screen. Everything here renders the CURRENT
 * observation the kernel handed the player, so it never disagrees with the
 * canvas, which folds the same session's event stream.
 */

export interface Feedback {
  results: readonly ActionResult[];
  wake: WakeResult | null;
  /** action_id -> what the player staged, kept across the submit. */
  labels: Readonly<Record<string, string>>;
}

export function OrdersPanel({ observation }: { observation: Observation }): JSX.Element {
  return (
    <div className="panel">
      <h3>待处理订单 ({observation.orders.length})</h3>
      {observation.orders.length === 0 ? (
        <p className="muted small">队列为空，等待新订单。</p>
      ) : (
        <ul className="plain card-list">
          {observation.orders.map((order) => {
            const waited = Math.max(0, observation.now_ms - order.arrived_at_ms);
            return (
              <li key={order.id} className="order-row">
                <div className="order-head">
                  <code>{order.id}</code>
                  <span className="money">{formatMinor(order.value_minor)}</span>
                  <span className="muted small">已等待 {formatSimMs(waited)}</span>
                </div>
                <div className="small">
                  {order.items.map((item) => (
                    <span className="pill" key={item.item_id}>
                      {itemLabel(item.item_id)}×{item.quantity}
                    </span>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function lotsByItem(lots: readonly Lot[]): Map<string, Lot[]> {
  const grouped = new Map<string, Lot[]>();
  for (const lot of fefoLots(lots)) {
    const list = grouped.get(lot.item_id);
    if (list) list.push(lot);
    else grouped.set(lot.item_id, [lot]);
  }
  return grouped;
}

export function InventoryPanel({
  observation,
  nowMs,
}: {
  observation: Observation;
  nowMs: number;
}): JSX.Element {
  const grouped = lotsByItem(observation.inventory);
  const entries = [...grouped.entries()].map(([item_id, lots]) => ({
    item_id,
    quantity: lots.reduce((sum, lot) => sum + lot.quantity, 0),
    oldest: lots[0],
    newest: lots[lots.length - 1],
    count: lots.length,
  }));

  return (
    <div className="panel">
      <h3>成品库存 ({entries.length})</h3>
      {entries.length === 0 ? (
        <p className="muted small">无在库成品 —— 先开工产出，再交付。</p>
      ) : (
        <ul className="plain card-list">
          {entries.map((entry) => (
            <li className="inv-row" key={entry.item_id}>
              <span>{itemLabel(entry.item_id)}</span>
              <span className="money">×{entry.quantity}</span>
              <span className="muted small">
                {entry.count} 批 · 最早 {entry.oldest ? formatSimMs(entry.oldest.produced_at_ms) : "—"} ·
                最新{" "}
                {entry.newest
                  ? `${formatSimMs(entry.newest.produced_at_ms)}（存放 ${formatSimMs(nowMs - entry.newest.produced_at_ms)}）`
                  : "—"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function StationsPanel({
  observation,
}: {
  observation: Observation;
}): JSX.Element {
  const tasks = new Map(observation.running_tasks.map((task) => [task.id, task] as const));
  return (
    <div className="panel">
      <h3>工位 ({observation.stations.length})</h3>
      <ul className="plain card-list">
        {observation.stations.map((station) => {
          const task = station.task_id === null ? undefined : tasks.get(station.task_id);
          const progress = task ? taskProgress(task, observation.now_ms) : 0;
          return (
            <li className="station-row" key={station.id}>
              <div className="order-head">
                <span>{stationLabel(station.id)}</span>
                <span className="muted small mono">{station.id}</span>
              </div>
              {task ? (
                <>
                  <div className="small">
                    {recipeLabel(task.recipe_id)} ×{task.batches} · 剩{" "}
                    {formatSimMs(Math.max(0, task.finish_at_ms - observation.now_ms))}
                  </div>
                  <div className="bar">
                    <span style={{ width: `${Math.round(progress * 100)}%` }} />
                  </div>
                </>
              ) : (
                <div className="small muted">空闲</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function FeedbackPanel({ feedback }: { feedback: Feedback | null }): JSX.Element {
  return (
    <div className="panel">
      <h3>上次结果</h3>
      {!feedback ? (
        <p className="muted small">推进时间后，这里会逐条显示每个动作的内核判定。</p>
      ) : (
        <>
          {feedback.results.length === 0 ? (
            <p className="muted small">上一次决策没有提交任何动作。</p>
          ) : (
            <ul className="plain card-list">
              {feedback.results.map((result) => (
                <li key={result.action_id} className={result.ok ? "feedback ok" : "feedback bad"}>
                  <div className="order-head">
                    <span>{feedback.labels[result.action_id] ?? result.action_id}</span>
                    <code className={result.ok ? "code-ok" : "code-bad"}>{result.code}</code>
                  </div>
                  <div className="small">
                    {actionCodeReason(result.code)}
                    {result.ok && result.entity_id ? ` · ${result.entity_id}` : ""}
                    {result.replayed ? " · 幂等缓存重放" : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {feedback.wake ? (
            <p className={"feedback " + (feedback.wake.ok ? "" : "bad")}>
              <code>{feedback.wake.code}</code> {wakeCodeReason(feedback.wake.code)}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export function StagedPanel({
  staged,
  isFinal,
  submitError,
  onRemove,
  onClear,
  onSubmit,
}: {
  staged: readonly StagedAction[];
  isFinal: boolean;
  submitError: string | null;
  onRemove: (actionId: string) => void;
  onClear: () => void;
  onSubmit: () => void;
}): JSX.Element {
  return (
    <div className="panel">
      <h3>本决策动作 ({staged.length})</h3>
      {staged.length === 0 ? (
        <p className="muted small">
          没有待提交的动作。也可以直接推进 —— 时钟会跳到下一个订单到达或任务完成。
        </p>
      ) : (
        <ul className="plain card-list">
          {staged.map((entry) => (
            <li className="staged-row" key={entry.action.action_id}>
              <span>{entry.label}</span>
              <button
                type="button"
                className="button ghost small"
                onClick={() => onRemove(entry.action.action_id)}
              >
                删除
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="button ghost small" onClick={onClear}>
              全部清空
            </button>
          </li>
        </ul>
      )}
      {submitError ? <p className="feedback bad">内核拒绝了这次提交：{submitError}</p> : null}
      <button type="button" className="button primary wide" onClick={onSubmit}>
        {isFinal ? "结算" : "推进时间"}
      </button>
    </div>
  );
}

export function EndPanel({
  bundle,
  done,
  best,
  isRecord,
  onRestart,
  onDownload,
}: {
  bundle: ScenarioBundle;
  done: RunOutput;
  best: number | null;
  isRecord: boolean;
  onRestart: () => void;
  onDownload: () => void;
}): JSX.Element {
  const { result } = done;
  const score = result.score_minor;
  const book = bundle.reference.book_value_minor;
  const greedy = bundle.reference.greedy_score_minor;
  const delta = score === null ? null : score - greedy;

  return (
    <div className="panel end-panel">
      <h3>打烊结算</h3>
      <div className="end-score">
        <span className="money">{formatMinor(score)}</span>
        <span className="muted small"> 本局成交总额</span>
        {isRecord ? <span className="pill good">新纪录</span> : null}
      </div>
      <dl className="kv">
        <dt>难度</dt>
        <dd>{DIFFICULTY_LABELS[bundle.config.difficulty] ?? bundle.config.difficulty}</dd>
        <dt>状态</dt>
        <dd>{STATUS_LABELS[result.status] ?? result.status}</dd>
        <dt>账面达成</dt>
        <dd>{score === null ? "—" : formatPercent(score, book)}</dd>
        <dt>营收</dt>
        <dd className="money">{formatMinor(result.revenue_minor)}</dd>
        <dt>已交付订单</dt>
        <dd>{result.delivered_orders}</dd>
        <dt>贪心 bot</dt>
        <dd className="money">
          {formatMinor(greedy)}
          {delta === null ? null : delta >= 0 ? (
            <span className="pill good"> 超过 {formatMinor(Math.abs(delta))}</span>
          ) : (
            <span className="pill bad"> 落后 {formatMinor(Math.abs(delta))}</span>
          )}
        </dd>
        <dt>本机最好</dt>
        <dd className="money">{best === null ? "—" : formatMinor(best)}</dd>
        <dt>决策 / 动作</dt>
        <dd>
          {done.stats.decisions} / {done.stats.totalActions}
        </dd>
      </dl>
      <div className="end-actions">
        <button type="button" className="button primary" onClick={onRestart}>
          再来一局
        </button>
        <a className="button" href={href("/play")}>
          换场景
        </a>
        <button type="button" className="button" onClick={onDownload}>
          下载回放 JSON
        </button>
      </div>
      <p className="muted small">
        回放与榜单同格式（<code>replay_kind: human</code>），可直接在本地内核里复核。
        本地成绩只写入浏览器 localStorage，不上传。
      </p>
    </div>
  );
}
