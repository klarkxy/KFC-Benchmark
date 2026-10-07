import type { ControllerModule } from "@kitchensched/contracts";

/**
 * Baseline: no-op controller. Handshake-valid, zero revenue.
 * The reference "legal floor" — a run that never acts must still
 * complete normally with score_minor = 0 (AT17).
 */
const controller: ControllerModule = {
  init() {},
  decide() {
    return { actions: [], wake_at_ms: null };
  },
};

export default controller;
