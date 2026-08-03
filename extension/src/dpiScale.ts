/** Supported designer display-DPR interval. The webview keeps logical WinForms coordinates independent from it. */
export const MIN_DISPLAY_DPR = 1;
export const MAX_DISPLAY_DPR = 2;

export interface DesignerDpiScale {
  /** Exact finite DPR reported by the webview after clamping; used to detect monitor/scaling changes. */
  displayDpr: number;
  /** Integer supersampling factor sent to both engines. Fractional DPR uses 2x to keep the cached net48 graph's
   * reversible integer Scale path and lets the browser downsample into the exact fractional device grid. */
  captureScale: 1 | 2;
}

export function designerDpiScale(value: unknown): DesignerDpiScale {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : MIN_DISPLAY_DPR;
  const displayDpr = Math.max(MIN_DISPLAY_DPR, Math.min(MAX_DISPLAY_DPR, numeric));
  return { displayDpr, captureScale: displayDpr > MIN_DISPLAY_DPR ? 2 : 1 };
}

/** Ignore sub-pixel/noise changes while still recognizing every Windows fractional step (1.25/1.5/1.75). */
export function displayDprChanged(previous: number, next: number): boolean {
  return Math.abs(previous - next) >= 0.01;
}
