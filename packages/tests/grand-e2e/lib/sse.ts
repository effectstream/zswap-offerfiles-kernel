// SSE recorder for /v1/offers/stream. Runs for the whole suite, reconnecting
// on drops (including the phase-6 sync-process restart), and keeps every event
// with a receive timestamp plus a log of connected/disconnected windows so the
// final audit can distinguish "event never emitted" from "we were not
// listening" (chaos makes gaps legitimate).

import { API } from "../config.ts";
import { sleep } from "./util.ts";

export interface SseRecord {
  at: number; // client receive time (ms epoch)
  event: any;
}

export class SseRecorder {
  readonly events: SseRecord[] = [];
  readonly windows: { from: number; to: number | null }[] = [];
  private stopped = false;
  private abort: AbortController | null = null;

  start(): void {
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const r = await fetch(`${API}/v1/offers/stream`, { signal: this.abort.signal });
        if (!r.ok || !r.body) throw new Error(`stream HTTP ${r.status}`);
        this.windows.push({ from: Date.now(), to: null });
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue; // ": heartbeat" comments
              try {
                this.events.push({ at: Date.now(), event: JSON.parse(line.slice(5).trim()) });
              } catch {
                /* non-JSON data frame — ignore */
              }
            }
          }
        }
      } catch {
        /* dropped — fall through to reconnect */
      }
      const open = this.windows[this.windows.length - 1];
      if (open && open.to === null) open.to = Date.now();
      if (!this.stopped) await sleep(2000);
    }
  }

  /** Was the recorder connected at time `t` (with a little slack)? */
  wasListeningAt(t: number, slackMs = 3000): boolean {
    return this.windows.some(
      (w) => t >= w.from + slackMs && t <= (w.to ?? Date.now()) - 0,
    );
  }

  ofType(type: string): SseRecord[] {
    return this.events.filter((e) => e.event?.type === type);
  }

  stop(): void {
    this.stopped = true;
    const open = this.windows[this.windows.length - 1];
    if (open && open.to === null) open.to = Date.now();
    this.abort?.abort();
  }
}
