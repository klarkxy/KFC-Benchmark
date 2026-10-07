import { useEffect, useRef } from "react";
import { drawReplay } from "./draw";
import type { ReplayState } from "./reducer";

const CANVAS_HEIGHT = 470;

/** Redraws the schematic kitchen whenever the folded state changes. */
export function ReplayCanvas({ state }: { state: ReplayState }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const available = canvas.parentElement?.clientWidth ?? 960;
    const width = Math.max(320, available);
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(CANVAS_HEIGHT * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${CANVAS_HEIGHT}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawReplay(context, state, width, CANVAS_HEIGHT);
  }, [state]);

  return <canvas ref={canvasRef} className="replay-canvas" />;
}
