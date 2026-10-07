import type { Id, ItemQty, Lot, LotQty, Order, PublicConfig, Recipe } from "@kitchensched/contracts";

/**
 * Pure helpers the game UI needs: unique action ids and earliest-expiry-first
 * lot picking. Nothing here touches the kernel, so the site can unit-test and
 * reuse them without a running session.
 *
 * Lots carry `produced_at_ms` but no expiry field (doc 02 §2), so FEFO is
 * "earliest production first", with the lot id as a stable tiebreak.
 */

/**
 * Monotonic action ids for one session. The kernel caches results by
 * `action_id` and replays a duplicate verbatim, so an id must never be reused
 * for a different action.
 */
export function createActionIdFactory(prefix: string = "a"): () => Id {
  let issued = 0;
  return () => `${prefix}-${(issued += 1)}`;
}

export interface LotPlan {
  /** Lot references in FEFO order; submit these on the action. */
  lots: LotQty[];
  /** Demand that no lot could cover; non-empty means the action cannot run yet. */
  missing: ItemQty[];
  /** True when `missing` is empty. */
  complete: boolean;
  /**
   * Reservation accumulator. A decision may carry several actions that draw on
   * the same lots, so pass this back into the next `planLots` call.
   */
  reserved: Map<Id, number>;
}

/** Sorts lots earliest-production-first; does not mutate the input. */
export function fefoLots(lots: readonly Lot[]): Lot[] {
  return [...lots].sort(
    (a, b) => a.produced_at_ms - b.produced_at_ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function toNeed(need: readonly ItemQty[] | ReadonlyMap<Id, number>): Map<Id, number> {
  const out = new Map<Id, number>();
  if (Array.isArray(need)) {
    for (const line of need as readonly ItemQty[]) {
      out.set(line.item_id, (out.get(line.item_id) ?? 0) + line.quantity);
    }
    return out;
  }
  for (const [item_id, quantity] of need as ReadonlyMap<Id, number>) {
    out.set(item_id, (out.get(item_id) ?? 0) + quantity);
  }
  return out;
}

/**
 * Picks the FEFO lots that would satisfy `need` from `inventory`. Lots already
 * promised by earlier actions of the same decision are taken off the table via
 * `reserved`, so two planned actions cannot both claim the same fries.
 *
 * A produced item that the kitchen has never made (`supply !== "produced"`)
 * simply has no lots; callers filter those out beforehand — see
 * `planStartInputs`.
 */
export function planLots(
  inventory: readonly Lot[],
  need: readonly ItemQty[] | ReadonlyMap<Id, number>,
  reserved: ReadonlyMap<Id, number> = new Map(),
): LotPlan {
  const outstanding = toNeed(need);
  const lots: LotQty[] = [];
  const nextReserved = new Map(reserved);
  for (const lot of fefoLots(inventory)) {
    const want = outstanding.get(lot.item_id) ?? 0;
    if (want <= 0) continue;
    const available = lot.quantity - (reserved.get(lot.id) ?? 0);
    const take = Math.min(want, available);
    if (take <= 0) continue;
    lots.push({ lot_id: lot.id, quantity: take });
    nextReserved.set(lot.id, (reserved.get(lot.id) ?? 0) + take);
    outstanding.set(lot.item_id, want - take);
  }
  const missing: ItemQty[] = [...outstanding.entries()]
    .filter(([, quantity]) => quantity > 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([item_id, quantity]) => ({ item_id, quantity }));
  return { lots, missing, complete: missing.length === 0, reserved: nextReserved };
}

/** Ids of the items the kitchen must produce (everything else is raw). */
export function producedItemIds(config: PublicConfig): ReadonlySet<Id> {
  return new Set(
    config.items.filter((item) => item.supply === "produced").map((item) => item.id),
  );
}

/**
 * The `input_lots` a start action needs: the recipe's produced inputs scaled by
 * `batches`. Unlimited raw inputs need no lot reference (doc 02 §4), so they are
 * dropped — pass the kitchen's produced set from `producedItemIds`.
 */
export function planStartInputs(
  inventory: readonly Lot[],
  recipe: Recipe,
  batches: number,
  produced: ReadonlySet<Id>,
  reserved: ReadonlyMap<Id, number> = new Map(),
): LotPlan {
  const need: ItemQty[] = recipe.inputs
    .filter((line) => produced.has(line.item_id))
    .map((line) => ({ item_id: line.item_id, quantity: line.quantity * batches }));
  return planLots(inventory, need, reserved);
}

/** The `output_lots` a deliver action needs: the whole order, no partial fill. */
export function planDeliverOutputs(
  inventory: readonly Lot[],
  order: Order,
  reserved: ReadonlyMap<Id, number> = new Map(),
): LotPlan {
  return planLots(inventory, order.items, reserved);
}
