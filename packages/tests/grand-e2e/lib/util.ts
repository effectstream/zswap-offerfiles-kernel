// Assertion registry + small shared utilities for the grand suite.
//
// Mirrors packages/tests/helpers.ts assert() style, but records results per
// phase so run.ts can render SCORECARD.md and decide the exit code.

import { mkdirSync, writeFileSync } from "node:fs";
import { OUT_DIR } from "../config.ts";
import { KNOWN_RED, unseenRedIds, type KnownRed } from "../known-red.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const toHex = (u: Uint8Array): string =>
  Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("");

export const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");

export interface CheckResult {
  phase: string;
  name: string;
  ok: boolean;
  detail?: string;
  ms: number;
  /** Set when this check is registered in KNOWN_RED — see known-red.ts. */
  red?: KnownRed;
  /** True when a KNOWN_RED check PASSED: the fix landed, the entry did not. */
  xpass?: boolean;
}

const results: CheckResult[] = [];
const seenRedKeys = new Set<string>();
let currentPhase = "p?";
let phaseStartMs = 0;
const phaseDurations: Record<string, number> = {};

export function beginPhase(phase: string): void {
  if (phaseStartMs) phaseDurations[currentPhase] = (phaseDurations[currentPhase] ?? 0) + (Date.now() - phaseStartMs);
  currentPhase = phase;
  phaseStartMs = Date.now();
  console.log(`\n═══ ${phase} ═══ ${new Date().toISOString()}\n`);
}

export function endPhases(): void {
  if (phaseStartMs) phaseDurations[currentPhase] = (phaseDurations[currentPhase] ?? 0) + (Date.now() - phaseStartMs);
  phaseStartMs = 0;
}

export async function check(
  name: string,
  fn: () => Promise<boolean> | boolean,
  detail?: string,
): Promise<boolean> {
  const started = Date.now();
  const full = `${currentPhase} ▸ ${name}`;
  let ok = false;
  let threw = false;
  let extra = detail;
  try {
    ok = await fn();
  } catch (e) {
    threw = true;
    extra = `${detail ? detail + "; " : ""}threw: ${e instanceof Error ? e.message : String(e)}`;
  }
  const ms = Date.now() - started;

  // Expected-failure handling. A registered check is asserting the truth about
  // a known product defect (known-red.ts): failing is the expected state and
  // must not gate the run, while PASSING means the fix landed and the registry
  // is stale — which DOES gate, because nothing else would ever make a fix PR
  // delete its own entry.
  //
  // The returned boolean is deliberately the RAW verdict either way, so callers
  // that branch on it (`if (!ok) continue`) behave exactly as before. Only what
  // is RECORDED changes.
  const red = KNOWN_RED[full];
  if (red && !threw) {
    // `!threw` is load-bearing. A registered red means "this check asserts the
    // truth and the product is currently wrong" — and a product being wrong is
    // signalled by the assertion returning false, NEVER by an exception. A
    // throw is a network fault, a null deref, an infra failure: unrelated
    // breakage that would otherwise be swallowed as the expected red and hidden
    // for as long as the entry lives.
    //
    // This originally demoted throws too, and the mechanism's own test codified
    // that as intended. It was wrong: it made every registered check a blind
    // spot for any crash inside it.
    seenRedKeys.add(full);
    if (ok) {
      results.push({
        phase: currentPhase, name, ok: false, ms, red, xpass: true,
        detail: `XPASS ${red.id}: now passes — delete the KNOWN_RED entry (${red.pr})`,
      });
      console.log(`[XPASS] ${full}  ← ${red.id} fixed; remove from KNOWN_RED (${red.pr})`);
    } else {
      results.push({
        phase: currentPhase, name, ok: true, ms, red,
        detail: `KNOWN RED ${red.id} (${red.pr}) — ${red.why}${extra ? `; observed: ${extra}` : ""}`,
      });
      console.log(`[RED ] ${full}  ← ${red.id} expected-fail, ${red.pr}${extra ? `  (${extra})` : ""}`);
    }
    return ok;
  }

  if (red && threw) {
    // Registered, but it crashed rather than asserting. Count the red as seen
    // (it did run) and fail the run — the entry is not evidence for this.
    seenRedKeys.add(full);
    results.push({
      phase: currentPhase, name, ok: false, ms,
      detail: `THREW inside registered red ${red.id} — not the expected defect: ${extra}`,
    });
    console.log(`[FAIL] ${full}  ← threw inside ${red.id}; a red is asserted, not crashed  (${extra})`);
    return false;
  }

  results.push({ phase: currentPhase, name, ok, detail: extra, ms });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${full}${!ok && extra ? `  (${extra})` : ""}`);
  return ok;
}

/** Record an informational (non-gating) observation into the scorecard. */
export function note(name: string, detail: string): void {
  results.push({ phase: currentPhase, name: `ℹ ${name}`, ok: true, detail, ms: 0 });
  console.log(`[NOTE] ${currentPhase} ▸ ${name}: ${detail}`);
}

export function allResults(): CheckResult[] {
  return results;
}

export function failures(): CheckResult[] {
  return results.filter((r) => !r.ok);
}

/** Checks that failed as expected — the punch list, rendered in the scorecard. */
export function knownReds(): CheckResult[] {
  return results.filter((r) => r.red && !r.xpass);
}

/**
 * Registered reds that never ran. Reported, NOT gated: a run that aborts early
 * (or skips a phase on a casualty) legitimately leaves entries unseen, so
 * failing here would punish unrelated breakage. The signal that matters is
 * that the entry's check has vanished from the suite — visible as the missing
 * name in the scorecard.
 */
export function staleReds(): KnownRed[] {
  return unseenRedIds(seenRedKeys);
}

export function phaseTimings(): Record<string, number> {
  return phaseDurations;
}

export function ensureOutDir(): void {
  mkdirSync(OUT_DIR, { recursive: true });
}

export function writeOut(file: string, content: string): void {
  ensureOutDir();
  writeFileSync(`${OUT_DIR}${file}`, content);
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export function summarizeLatencies(samples: number[]): { count: number; p50: number; p95: number; max: number } {
  const s = [...samples].sort((a, b) => a - b);
  return { count: s.length, p50: percentile(s, 50), p95: percentile(s, 95), max: s[s.length - 1] ?? 0 };
}

/** RSS in KB for a pid, via ps (Linux/macOS). 0 when the pid is gone. */
export async function rssKb(pid: number): Promise<number> {
  try {
    const proc = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

/** First pid whose full command line matches `pattern` (pgrep -f). */
export async function pgrepF(pattern: string): Promise<number | null> {
  try {
    const proc = Bun.spawn(["pgrep", "-f", pattern], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    const pid = Number(out.trim().split("\n")[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Deterministic per-index variation in [0, span) — replaces Math.random. */
export function detVar(index: number, span: number, salt = 0): number {
  // xorshift-ish integer hash; stable across runs and platforms.
  let x = (index + 1) * 2654435761 + salt * 40503;
  x = (x ^ (x >>> 16)) >>> 0;
  return x % span;
}

export async function waitUntil(
  name: string,
  fn: () => Promise<boolean>,
  tries = 36,
  ms = 5000,
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await sleep(ms);
  }
  console.log(`  (waitUntil "${name}" timed out after ${(tries * ms) / 1000}s)`);
  return false;
}
