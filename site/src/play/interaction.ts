import type { MouseEvent } from "react";

/**
 * Space and Enter are the game's pause keys, but a button that keeps focus
 * after a click swallows them: press 4× then Space and the browser re-fires
 * the speed button instead of pausing. Releasing focus right after the click
 * hands the keyboard back to the document handler, and it matches what the
 * player asked for by tapping a control once.
 */
export function releaseFocus(event: MouseEvent<HTMLElement>): void {
  event.currentTarget.blur();
}
