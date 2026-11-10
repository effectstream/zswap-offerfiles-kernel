// production-guide.ts — check that deploy/PRODUCTION.md names only things
// that exist in this tree, like a link checker:
//
//   paths          repository-relative paths in inline code, and the files
//                  `bun run <file>` / `bun <file>` commands run
//   package scripts `bun run <script>` (root package.json) and
//                  `bun run --filter <package> <script>`
//   links          relative Markdown links, and their #anchors in Markdown
//                  targets
//   env names      UPPER_SNAKE names; each must occur in a non-Markdown file of
//                  the tree (code, scripts, env examples, Dockerfiles), or be a
//                  variable of an external program listed below. `NAME_*`
//                  needs one variable with that prefix.
//
// Absolute host paths (/etc/…, /var/lib/…), URLs and API routes (/v1/…) are not
// repository paths and are not checked.
//
// Usage: bun run deploy/scripts/lib/production-guide.ts [guide] [repo-root]
// Exit 0 when nothing is missing, 1 otherwise.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Variables read by programs outside this repository, with the reader. */
export const EXTERNAL_ENV: Readonly<Record<string, string>> = Object.freeze({
  MIDNIGHT_PROOF_SERVER_NUM_WORKERS: "the Midnight proof server binary",
});

export type ReferenceKind = "path" | "package-script" | "link" | "anchor" | "env";

export interface GuideReference {
  kind: ReferenceKind;
  value: string;
  line: number;
}

export interface MissingReference extends GuideReference {
  reason: string;
}

export interface GuideCheck {
  references: GuideReference[];
  missing: MissingReference[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".compact-cache"]);
const CODE_FILE = /\.(ts|tsx|js|mjs|cjs|sh|ya?ml|json|toml|sql|example)$/;
const ENV_NAME = /\b[A-Z][A-Z0-9]*(?:(?:_[A-Z0-9]+)+(?:_\*)?|_\*)/g;
const BUN_BUILTINS = new Set(["install", "add", "remove", "test", "x", "build", "pm", "upgrade", "-e", "--version", "--help"]);

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export function headingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (!match) continue;
    const base = headingSlug(match[1]!);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

function walk(root: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(root, entry.name), visit);
    } else if (entry.isFile()) {
      visit(join(root, entry.name));
    }
  }
}

/** Every upper-case word (four characters or more) of the tree's non-Markdown files. */
function treeEnvWords(repoRoot: string, exclude: string): Set<string> {
  const words = new Set<string>();
  walk(repoRoot, (file) => {
    if (file === exclude) return;
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (!CODE_FILE.test(name) && name !== "Dockerfile" && !name.startsWith(".env")) return;
    if (statSync(file).size > 2_000_000) return;
    for (const word of readFileSync(file, "utf8").match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? []) {
      words.add(word);
    }
  });
  return words;
}

function looksLikeRepoPath(text: string): boolean {
  if (/\s|<|>|\$|\*/.test(text) || text.startsWith("/") || /^[a-z]+:\/\//i.test(text)) return false;
  if (text.includes("/")) return /^[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)+\/?$/.test(text);
  return /^\.?[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(ts|md|json|example|ya?ml|sh)$/.test(text);
}

/** Files and scripts a `bun …` command names, from one line of text. */
function bunTargets(text: string): Array<{ kind: "path" | "package-script"; value: string }> {
  const out: Array<{ kind: "path" | "package-script"; value: string }> = [];
  const commands = text.matchAll(/(?:^|[\s/`(;&|])bun((?:\s+[^\s;&|`)]+)+)/g);
  for (const command of commands) {
    const words = command[1]!.trim().split(/\s+/);
    let i = 0;
    if (words[i] === "run") i += 1;
    else if (BUN_BUILTINS.has(words[i] ?? "")) continue;
    if (words[i] === "--filter") {
      const pkg = words[i + 1];
      const script = words[i + 2];
      if (pkg && script) out.push({ kind: "package-script", value: `${pkg} ${script}` });
      continue;
    }
    const target = words[i];
    if (target === undefined || target.startsWith("-") || target.startsWith("$") || target.startsWith("\"")) continue;
    if (/\.(ts|js|mjs)$/.test(target)) out.push({ kind: "path", value: target });
    else if (/^[a-z][\w:.-]*$/.test(target)) out.push({ kind: "package-script", value: target });
  }
  return out;
}

function packageScripts(repoRoot: string): { root: Set<string>; byPackage: Map<string, Set<string>> } {
  const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { name?: string; scripts?: Record<string, string> };
  const root = new Set(Object.keys(read(join(repoRoot, "package.json")).scripts ?? {}));
  const byPackage = new Map<string, Set<string>>();
  for (const dir of ["packages", "docs"]) {
    const base = join(repoRoot, dir);
    if (!existsSync(base)) continue;
    const candidates = dir === "docs" ? [base] : readdirSync(base).map((name) => join(base, name));
    for (const candidate of candidates) {
      const manifest = join(candidate, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = read(manifest);
      if (pkg.name) byPackage.set(pkg.name, new Set(Object.keys(pkg.scripts ?? {})));
    }
  }
  return { root, byPackage };
}

/** Collect every reference the guide makes, then check each against the tree. */
export function checkProductionGuide(guidePath: string, repoRoot: string): GuideCheck {
  const guide = readFileSync(guidePath, "utf8");
  const guideDir = dirname(guidePath);
  const references: GuideReference[] = [];
  const add = (kind: ReferenceKind, value: string, line: number) => {
    if (!references.some((r) => r.kind === kind && r.value === value)) references.push({ kind, value, line });
  };

  let inFence = false;
  guide.split("\n").forEach((text, index) => {
    const line = index + 1;
    if (/^\s*```/.test(text)) {
      inFence = !inFence;
      return;
    }
    for (const target of bunTargets(text)) add(target.kind, target.value, line);
    for (const match of text.matchAll(ENV_NAME)) add("env", match[0], line);
    if (inFence) return;
    for (const span of text.matchAll(/`([^`]+)`/g)) {
      const code = span[1]!.trim();
      if (looksLikeRepoPath(code)) add("path", code.replace(/^\.\//, ""), line);
      // A one-word variable such as `PGLITE` has no underscore for ENV_NAME.
      if (/^[A-Z][A-Z0-9]{3,}$/.test(code)) add("env", code, line);
    }
    for (const link of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = link[1]!;
      if (/^[a-z]+:/i.test(target)) continue;
      const [file, anchor] = target.split("#", 2) as [string, string | undefined];
      if (file !== "") add("link", relative(repoRoot, resolve(guideDir, file)), line);
      if (anchor !== undefined) {
        add("anchor", `${file === "" ? relative(repoRoot, guidePath) : relative(repoRoot, resolve(guideDir, file))}#${anchor}`, line);
      }
    }
  });

  const missing: MissingReference[] = [];
  const miss = (ref: GuideReference, reason: string) => missing.push({ ...ref, reason });
  const envWords = references.some((r) => r.kind === "env") ? treeEnvWords(repoRoot, guidePath) : new Set<string>();
  const scripts = packageScripts(repoRoot);

  for (const ref of references) {
    switch (ref.kind) {
      case "path":
      case "link":
        if (!existsSync(join(repoRoot, ref.value))) miss(ref, "no such file or directory in the tree");
        break;
      case "anchor": {
        const [file, anchor] = ref.value.split("#", 2) as [string, string];
        const path = join(repoRoot, file);
        if (!existsSync(path) || !file.endsWith(".md")) break;
        if (!anchorsOf(readFileSync(path, "utf8")).has(anchor)) miss(ref, `no heading with anchor #${anchor} in ${file}`);
        break;
      }
      case "package-script": {
        const parts = ref.value.split(" ");
        if (parts.length === 2) {
          const pkgScripts = scripts.byPackage.get(parts[0]!);
          if (pkgScripts === undefined) miss(ref, `no workspace package named ${parts[0]}`);
          else if (!pkgScripts.has(parts[1]!)) miss(ref, `${parts[0]} has no script "${parts[1]}"`);
        } else if (!scripts.root.has(ref.value)) {
          miss(ref, `the root package.json has no script "${ref.value}"`);
        }
        break;
      }
      case "env": {
        if (ref.value.endsWith("_*")) {
          const prefix = ref.value.slice(0, -1);
          if (![...envWords].some((word) => word.startsWith(prefix))) miss(ref, `no variable starting with ${prefix} in the tree`);
        } else if (!envWords.has(ref.value) && !(ref.value in EXTERNAL_ENV)) {
          miss(ref, "named nowhere in the tree's code, scripts or env examples");
        }
        break;
      }
    }
  }
  return { references, missing };
}

if (import.meta.main) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(process.argv[3] ?? join(here, "..", "..", ".."));
  const guidePath = resolve(process.argv[2] ?? join(repoRoot, "deploy", "PRODUCTION.md"));
  const { references, missing } = checkProductionGuide(guidePath, repoRoot);
  const counts = new Map<string, number>();
  for (const ref of references) counts.set(ref.kind, (counts.get(ref.kind) ?? 0) + 1);
  console.log(
    `[production-guide] ${relative(repoRoot, guidePath)}: ${references.length} references ` +
      `(${[...counts].map(([kind, n]) => `${kind} ${n}`).join(", ")}); missing ${missing.length}`,
  );
  for (const ref of missing) console.log(`  MISSING ${ref.kind} ${ref.value} (line ${ref.line}): ${ref.reason}`);
  process.exit(missing.length === 0 ? 0 : 1);
}
