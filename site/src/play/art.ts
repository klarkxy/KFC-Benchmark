/**
 * Cartoon art for the play screens, generated with GPT image gen.
 *
 * Everything is imported through Vite, so the emitted URLs are relative and
 * the same bundle works at `/` and under a `/KFC-Benchmark/` project path —
 * no `/public` absolutes anywhere. Emoji stays the fallback for any station
 * this map does not know.
 *
 * To swap a picture: drop the replacement in `./assets/` and change the one
 * line below. Nothing else in the UI names a file.
 */
import bgKitchen from "./assets/bg_kitchen.webp";
import heroPicker from "./assets/hero_picker.webp";
import iconCounter from "./assets/icon_counter.webp";
import iconFryer from "./assets/icon_fryer.webp";
import iconGrill from "./assets/icon_grill.webp";
import iconMarinator from "./assets/icon_marinator.webp";
import iconOven from "./assets/icon_oven.webp";
import iconPackager from "./assets/icon_packager.webp";

/** Wide backdrop behind the station grid. */
export const KITCHEN_BACKDROP = bgKitchen;

/** Banner at the top of the level select. */
export const PICKER_HERO = heroPicker;

export interface StationArt {
  src: string;
  /** Intrinsic size, so the <img> reserves its box before the bytes land. */
  width: number;
  height: number;
}

const STATION_ART: Readonly<Record<string, StationArt>> = {
  "st.fryer": { src: iconFryer, width: 246, height: 256 },
  "st.oven": { src: iconOven, width: 256, height: 213 },
  "st.grill": { src: iconGrill, width: 256, height: 171 },
  "st.counter": { src: iconCounter, width: 256, height: 171 },
  "st.packager": { src: iconPackager, width: 256, height: 213 },
  "st.marinator": { src: iconMarinator, width: 256, height: 256 },
};

/** null means "no art for this station" — the tile falls back to its emoji. */
export function stationArt(id: string): StationArt | null {
  return STATION_ART[id] ?? null;
}
