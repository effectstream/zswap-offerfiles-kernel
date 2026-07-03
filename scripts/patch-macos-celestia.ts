// macOS 26+'s dyld rejects Go binaries whose __DATA_CONST segment lacks the
// SG_READ_ONLY flag with `dyld: __DATA_CONST segment missing SG_READ_ONLY
// flag` → SIGABRT. celestia-appd v6.4.10 (vendored by @effectstream/celestia)
// ships without it, so `celestia-appd version` crashes and the dev stack can't
// start Celestia. This sets the flag and ad-hoc re-signs every Mach-O in the
// package's vendor dir. Idempotent; a no-op off macOS.
//
// ponytail: patches binaries already downloaded into vendor/. A pristine
// install downloads celestia-appd lazily on the first `bun run dev`, and
// bin-wrapper downloads-and-runs it atomically — so that first run still
// crashes once; re-run `bun run dev` and this predev step heals it. Upgrade
// path if the one-time crash annoys: pre-download the tarball here.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SG_READ_ONLY = 0x10;
const LC_SEGMENT_64 = 0x19;
const MH_MAGIC_64 = 0xfeedfacf; // Mach-O 64-bit, little-endian (all macOS archs)

if (process.platform !== "darwin") process.exit(0);

const vendor = join(
  dirname(fileURLToPath(import.meta.resolve("@effectstream/celestia"))),
  "vendor",
);
if (!existsSync(vendor)) {
  console.log(`[patch-macos-celestia] ${vendor} not present yet — nothing to patch`);
  process.exit(0);
}

// Set SG_READ_ONLY on the __DATA_CONST segment. Returns true if it changed.
function patchSegmentFlag(path: string): boolean {
  const buf = readFileSync(path);
  if (buf.length < 32 || buf.readUInt32LE(0) !== MH_MAGIC_64) return false; // not thin LE Mach-O
  const ncmds = buf.readUInt32LE(16);
  let off = 32; // sizeof(mach_header_64)
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(off);
    const cmdsize = buf.readUInt32LE(off + 4);
    if (cmd === LC_SEGMENT_64) {
      const segname = buf.toString("latin1", off + 8, off + 24).replace(/\0.*$/, "");
      if (segname === "__DATA_CONST") {
        const flagsOff = off + 68; // cmd,cmdsize,segname[16],4×u64,2×i32,nsects
        const flags = buf.readUInt32LE(flagsOff);
        if (flags & SG_READ_ONLY) return false;
        buf.writeUInt32LE(flags | SG_READ_ONLY, flagsOff);
        writeFileSync(path, buf);
        return true;
      }
    }
    off += cmdsize;
  }
  return false;
}

for (const name of readdirSync(vendor)) {
  const path = join(vendor, name);
  if (!statSync(path).isFile()) continue;
  try {
    if (patchSegmentFlag(path)) {
      execFileSync("codesign", ["-f", "-s", "-", path], { stdio: "pipe" });
      console.log(`[patch-macos-celestia] patched + re-signed ${name}`);
    }
  } catch (err) {
    console.warn(`[patch-macos-celestia] could not patch ${name}: ${(err as Error).message}`);
  }
}
