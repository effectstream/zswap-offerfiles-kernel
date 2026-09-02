import { expect, test } from "bun:test";

import type { SolverAdmissionEnv } from "./env.ts";
import { startAdmissionWarnings } from "./src/admission.ts";

const admission = (openGroups: string[]): SolverAdmissionEnv => ({
  supportedPairs: null,
  minJobOutput: null,
  dust: null,
  warningIntervalMs: 123,
  openGroups,
});

test("Q-RF-2 warning is immediate, periodic, contained, and stops exactly", () => {
  let tick: (() => void) | null = null;
  let cleared = 0;
  const messages: string[] = [];
  const handle = startAdmissionWarnings(admission(["PAIRS", "DUST"]), (message) => {
    messages.push(message);
    if (messages.length === 1) throw new Error("diagnostic failed");
  }, {
    setInterval: (callback, interval) => {
      expect(interval).toBe(123);
      tick = callback;
      return "timer";
    },
    clearInterval: (timer) => {
      expect(timer).toBe("timer");
      cleared += 1;
    },
  });
  expect(messages).toEqual([
    "[ADMISSION] PAIRS is UNSET: this policy group is OPEN",
    "[ADMISSION] DUST is UNSET: this policy group is OPEN",
  ]);
  tick!();
  expect(messages).toHaveLength(4);
  handle.stop();
  handle.stop();
  tick!();
  expect(messages).toHaveLength(4);
  expect(cleared).toBe(1);
});

test("SET admission starts no warning timer", () => {
  let timers = 0;
  const messages: string[] = [];
  startAdmissionWarnings(admission([]), (message) => messages.push(message), {
    setInterval: () => { timers += 1; return 1; },
    clearInterval: () => {},
  }).stop();
  expect(messages).toEqual([]);
  expect(timers).toBe(0);
});
