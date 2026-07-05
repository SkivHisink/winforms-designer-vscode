// Minimal ambient declaration for the parts of jsdom the webview test harness uses. jsdom ships no types
// and we intentionally avoid adding @types/jsdom (extra dep tree) — the harness treats the window as `any`.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly window: any;
  }
}
