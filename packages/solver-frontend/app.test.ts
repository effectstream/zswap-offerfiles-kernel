import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { buildMonitorSnapshot } from "./test-helpers/fixtures.ts";

// Execute the actual browser entry and its imports. Only browser I/O is fake;
// neither the render path nor the poll/SSE callbacks are replaced by the test.
const built = await Bun.build({
  entrypoints: [new URL("./public/app.js", import.meta.url).pathname],
  target: "browser",
  format: "iife",
});
if (!built.success) throw new Error(built.logs.join("\n"));
const app = await built.outputs[0]!.text();

class Element {
  children: Element[] = [];
  private text = "";
  private attributes = new Map<string, string>();
  private selected = new Map<string, Element>();
  style = {};
  dataset = {};
  className = "";
  hidden = false;
  classList = { toggle() {} };
  constructor(readonly tag = "div") {}
  get firstChild() { return this.children[0] ?? null; }
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...children: Element[]) { this.children.push(...children); }
  removeChild(child: Element) { this.children.splice(this.children.indexOf(child), 1); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  removeAttribute(key: string) { this.attributes.delete(key); }
  addEventListener() {}
  querySelector(selector: string): Element {
    if (!this.selected.has(selector)) this.selected.set(selector, new Element());
    return this.selected.get(selector)!;
  }
}

async function flush() {
  // Drain the response.json/render/connect promise chain without real timers.
  for (let step = 0; step < 12; step++) await Promise.resolve();
}

async function openPage(initial: any) {
  let response = initial;
  const elements = new Element();
  const intervals = new Map<number, { callback: () => void; delay: number }>();
  const timeouts: Array<() => void> = [];
  const streams: FakeStream[] = [];
  class FakeStream {
    private listeners = new Map<string, (event: any) => void>();
    constructor() { streams.push(this); }
    addEventListener(kind: string, callback: (event: any) => void) { this.listeners.set(kind, callback); }
    close() {}
    message(snapshot: any) { this.listeners.get("message")!({ data: JSON.stringify(snapshot) }); }
    error() { this.listeners.get("error")!({}); }
  }
  runInNewContext(app, {
    document: {
      documentElement: new Element(),
      body: new Element(),
      querySelector: (selector: string) => elements.querySelector(selector),
      querySelectorAll: () => [],
      createElement: (tag: string) => new Element(tag),
      createTextNode: (text: string) => { const node = new Element("#text"); node.textContent = text; return node; },
      addEventListener() {},
    },
    localStorage: { getItem: () => null },
    addEventListener() {},
    fetch: async () => ({ ok: true, json: async () => response }),
    EventSource: FakeStream,
    setInterval: (callback: () => void, delay: number) => {
      const id = intervals.size + 1;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval: (id: number) => intervals.delete(id),
    setTimeout: (callback: () => void) => timeouts.push(callback),
    URL,
  });
  await flush();
  return {
    node: (selector: string) => elements.querySelector(selector),
    streams,
    respondWith: (snapshot: any) => { response = snapshot; },
    reconnect: () => timeouts.shift()!(),
    poll: async () => {
      [...intervals.values()].find((timer) => timer.delay === 10000)!.callback();
      await flush();
    },
  };
}

describe("browser reconnect contract gate", () => {
  for (const transport of ["poll", "SSE"]) {
    for (const [version, message] of [
      [2, "older monitor contract v2"],
      [4, "unknown newer monitor contract v4"],
      [undefined, "does not report a valid monitor contract version"],
    ] as const) {
      test(`${transport} clears old provenance for monitor ${String(version)} and recovers on v3`, async () => {
        const good: any = buildMonitorSnapshot();
        const page = await openPage(good);
        expect(page.node("#pill").textContent).toBe("QUOTING");
        expect(page.node("#ladders").textContent).toContain("750 000");
        expect(page.node("#book").textContent).toContain("TKB");
        const incompatible = structuredClone(good);
        incompatible.monitor.contractVersion = version;
        incompatible.solver.contractVersion = version;
        incompatible.solver.expectedContractVersion = version;
        incompatible.solver.snapshot.contractVersion = version;
        if (transport === "poll") {
          page.respondWith(incompatible);
          page.streams[0]!.error(); // no frames: fallback poll
          await flush();
        } else {
          page.streams[0]!.message(good);
          page.streams[0]!.error(); // after frames: immediate reconnect
          page.reconnect();
          page.streams[1]!.message(incompatible);
        }
        expect(page.node("#pill").textContent).toBe("INCOMPATIBLE CONTRACT");
        expect(page.node("#alarms").textContent).toContain(message);
        expect(page.node("#ladders-count").textContent).toBe("incompatible contract");
        expect(page.node("#ladders").textContent).not.toContain("750 000");
        expect(page.node("#book").textContent).not.toContain("TKB");
        expect(page.node("#jobs").textContent).not.toContain("RELAY_SUBMITTED");
        if (transport === "poll") {
          page.respondWith(good);
          await page.poll();
        } else {
          page.streams[1]!.message(good);
        }
        expect(page.node("#pill").textContent).toBe("QUOTING");
        expect(page.node("#alarms").hidden).toBe(true);
        expect(page.node("#ladders").textContent).toContain("750 000");
      });
    }
  }

  test("missing v3 accounting visibly reports unknown receipts after a valid frame", async () => {
    const snapshot: any = buildMonitorSnapshot();
    const page = await openPage(snapshot);
    for (const pair of snapshot.solver.snapshot.ladder.last.provenance) {
      for (const combination of pair.combinations) delete combination.tokenBalances;
    }
    page.streams[0]!.message(snapshot);
    expect(page.node("#ladders").textContent).toContain("unknown receipts: missing token accounting");
    expect(page.node("#ladders").textContent).not.toContain("none");
  });
});
