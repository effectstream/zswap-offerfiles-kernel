// pglite-entrypoint.test.ts — the pglite service's entrypoint, forwarder and
// healthcheck, RUN for real: bash supervising the PGlite server from
// node_modules and pglite-forwarder.ts, with clients that connect to this
// host's own non-loopback IPv4 address, the way another container reaches the
// service.
//
// Proves, without Docker:
//   * through DB_PORT on a non-loopback address a client completes a Postgres
//     startup and runs queries, a 4 MB result arrives intact, and DB_PORT
//     accepts nothing before the server listens on loopback;
//   * SIGTERM and SIGINT stop both processes (exit 143 / 130);
//   * when either process dies, the other is stopped and the script exits
//     non-zero;
//   * the healthcheck passes only when a Postgres server answers through a
//     non-loopback address: not for a server bound to loopback only, and not
//     for a forwarder whose server is down;
//   * the forwarder relays a server-side close, and exits non-zero when its
//     port is taken or an argument is not a port.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const IMAGE_DIR = join(REPO_ROOT, "deploy/images/kernel");
const BUN = process.execPath;
const BASH = Bun.which("bash") ?? "/bin/bash";
const PGLITE_BOOT_MS = 90_000;
// For the cases that start no PGlite: well above their few-hundred-ms runtime,
// so a slow runner fails on an assertion, not on bun's 5 s default.
const QUICK_MS = 30_000;

// The address another container would use: any non-loopback IPv4 address of
// this host. The forwarder listens on 0.0.0.0, so every one of them works.
const EXTERNAL_IPV4 = Object.values(networkInterfaces())
  .flat()
  .find((iface) => iface !== undefined && iface.family === "IPv4" && !iface.internal)?.address;

let scratch = "";
let binDir = "";
const procs: Proc[] = [];
const pids: number[] = [];
const servers: net.Server[] = [];

beforeAll(() => {
  if (EXTERNAL_IPV4 === undefined) {
    throw new Error("these tests need a non-loopback IPv4 address on this host");
  }
  scratch = mkdtempSync(join(tmpdir(), "pglite-entrypoint-"));
  binDir = join(scratch, "usr-local-bin");
  mkdirSync(binDir, { recursive: true });
  for (const file of ["entrypoint-pglite.sh", "entrypoint-common.sh", "wait-for.sh"]) {
    const src = readFileSync(join(IMAGE_DIR, file), "utf8").replaceAll("/usr/local/bin/", `${binDir}/`);
    writeFileSync(join(binDir, file), src);
    chmodSync(join(binDir, file), 0o755);
  }
  for (const file of ["pglite-forwarder.ts", "pglite-healthcheck.ts"]) {
    writeFileSync(join(binDir, file), readFileSync(join(IMAGE_DIR, file)));
  }
});

afterEach(async () => {
  for (const p of procs.splice(0)) p.proc.kill("SIGKILL");
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

// ── processes ────────────────────────────────────────────────────────────────

class Proc {
  output = "";
  readonly proc: Bun.Subprocess<"ignore", "pipe", "pipe">;

  private readonly pumps: Promise<void>[];

  constructor(cmd: string[], env: Record<string, string>) {
    this.proc = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    procs.push(this);
    this.pumps = [this.pump(this.proc.stdout), this.pump(this.proc.stderr)];
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) this.output += decoder.decode(chunk, { stream: true });
  }

  async waitFor(pattern: RegExp, timeoutMs: number): Promise<RegExpMatchArray> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = this.output.match(pattern);
      if (match) return match;
      if (Date.now() > deadline) throw new Error(`no ${pattern} within ${timeoutMs} ms; output:\n${this.output}`);
      await Bun.sleep(25);
    }
  }

  /** The exit code, or "timeout" when the process is still running after `ms`.
   *  Output is read to its end first (bounded: a surviving grandchild may hold
   *  the pipes open). */
  async exitWithin(ms: number): Promise<number | "timeout"> {
    const code = await Promise.race([
      this.proc.exited,
      Bun.sleep(ms).then(() => "timeout" as const),
    ]);
    if (code !== "timeout") await Promise.race([Promise.all(this.pumps), Bun.sleep(1_000)]);
    return code;
  }
}

/** True while `pid` is a running (not zombie) process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "0.0.0.0", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolvePort(port));
    });
  });
}

/** Resolves when a TCP connect to host:port succeeds; false after `ms`. */
async function accepts(host: string, port: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() <= deadline) {
    const ok = await new Promise<boolean>((r) => {
      const s = net.connect({ host, port });
      s.once("connect", () => {
        s.destroy();
        r(true);
      });
      s.once("error", () => r(false));
    });
    if (ok) return true;
    await Bun.sleep(10);
  }
  return false;
}

interface Entrypoint {
  run: Proc;
  dbPort: number;
  loopbackPort: number;
  serverPid: number;
  forwarderPid: number;
  /** performance.now() of the first accepted connection on each port. */
  firstAccept: { server: number; forwarder: number };
}

async function startEntrypoint(): Promise<Entrypoint> {
  const dbPort = await freePort();
  let loopbackPort = await freePort();
  while (loopbackPort === dbPort) loopbackPort = await freePort();
  const dataDir = mkdtempSync(join(scratch, "data-"));
  const run = new Proc([BASH, join(binDir, "entrypoint-pglite.sh")], {
    PATH: `${dirname(BUN)}:/usr/bin:/bin`,
    HOME: scratch,
    REPO_ROOT,
    PGLITE_DATA_DIR: dataDir,
    DB_PORT: String(dbPort),
    PGLITE_LOOPBACK_PORT: String(loopbackPort),
  });
  const firstAcceptOn = async (host: string, port: number) => {
    if (!(await accepts(host, port, PGLITE_BOOT_MS))) throw new Error(`${host}:${port} never accepted`);
    return performance.now();
  };
  const [server, forwarder] = await Promise.all([
    firstAcceptOn("127.0.0.1", loopbackPort),
    firstAcceptOn(EXTERNAL_IPV4!, dbPort),
  ]);
  const serverPid = Number((await run.waitFor(/server pid (\d+)/, 5_000))[1]);
  const forwarderPid = Number((await run.waitFor(/forwarder pid (\d+)/, 5_000))[1]);
  pids.push(serverPid, forwarderPid);
  return { run, dbPort, loopbackPort, serverPid, forwarderPid, firstAccept: { server, forwarder } };
}

async function healthcheck(dbPort: number): Promise<number> {
  const check = new Proc([BUN, join(binDir, "pglite-healthcheck.ts")], {
    PATH: `${dirname(BUN)}:/usr/bin:/bin`,
    HOME: scratch,
    DB_PORT: String(dbPort),
  });
  const code = await check.exitWithin(15_000);
  if (code === "timeout") throw new Error("the healthcheck did not finish within 15 s");
  return code;
}

/** A stand-in Postgres server that only answers an SSLRequest with 'N'. */
async function sslResponder(host: string, port: number): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => socket.end(Buffer.from("N")));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(port, host, () => r()));
  return server;
}

async function sslAnswer(host: string, port: number): Promise<string | undefined> {
  return await new Promise((r) => {
    const s = net.connect({ host, port });
    const done = (v: string | undefined) => {
      s.destroy();
      r(v);
    };
    s.once("connect", () => s.write(Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])));
    s.once("data", (d: Buffer) => done(String.fromCharCode(d[0]!)));
    s.once("error", () => done(undefined));
    s.once("close", () => done(undefined));
  });
}

// ── a minimal Postgres wire-protocol client (simple query protocol) ─────────

class PgClient {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private closed = false;
  private wake: (() => void) | undefined;

  private constructor(private readonly socket: net.Socket) {
    socket.on("data", (d: Buffer) => {
      this.chunks.push(d);
      this.buffered += d.length;
      this.wake?.();
    });
    socket.on("close", () => {
      this.closed = true;
      this.wake?.();
    });
    socket.on("error", () => {});
  }

  static async connect(host: string, port: number): Promise<PgClient> {
    const socket = net.connect({ host, port });
    await new Promise<void>((r, j) => {
      socket.once("connect", () => r());
      socket.once("error", j);
    });
    return new PgClient(socket);
  }

  private take(n: number): Buffer {
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    this.chunks = all.length > n ? [all.subarray(n)] : [];
    this.buffered -= n;
    return all.subarray(0, n);
  }

  private async message(deadline: number): Promise<{ type: string; body: Buffer }> {
    for (;;) {
      if (this.buffered >= 5) {
        const head = this.take(5);
        const length = head.readInt32BE(1) - 4;
        while (this.buffered < length) {
          if (this.closed) throw new Error("the server closed the connection mid-message");
          await this.sleepUntilData(deadline);
        }
        return { type: String.fromCharCode(head[0]!), body: Buffer.from(this.take(length)) };
      }
      if (this.closed) throw new Error("the server closed the connection");
      await this.sleepUntilData(deadline);
    }
  }

  private async sleepUntilData(deadline: number): Promise<void> {
    if (Date.now() > deadline) throw new Error("timed out waiting for the server");
    await new Promise<void>((r) => {
      this.wake = r;
      setTimeout(r, 100);
    });
    this.wake = undefined;
  }

  private static errorText(body: Buffer): string {
    for (let i = 0; i < body.length && body[i] !== 0; ) {
      const field = String.fromCharCode(body[i]!);
      const end = body.indexOf(0, i + 1);
      if (field === "M") return body.subarray(i + 1, end).toString("utf8");
      i = end + 1;
    }
    return "unknown error";
  }

  async startup(timeoutMs: number): Promise<void> {
    const params = Buffer.from("user\0postgres\0database\0postgres\0\0", "utf8");
    const head = Buffer.alloc(8);
    head.writeInt32BE(8 + params.length, 0);
    head.writeInt32BE(196608, 4); // protocol 3.0
    this.socket.write(Buffer.concat([head, params]));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { type, body } = await this.message(deadline);
      if (type === "E") throw new Error(`startup failed: ${PgClient.errorText(body)}`);
      if (type === "R" && body.readInt32BE(0) !== 0) throw new Error("the server asked for a password");
      if (type === "Z") return;
    }
  }

  async query(sql: string, timeoutMs: number): Promise<Array<Array<string | null>>> {
    const text = Buffer.from(`${sql}\0`, "utf8");
    const head = Buffer.alloc(5);
    head.write("Q", 0);
    head.writeInt32BE(4 + text.length, 1);
    this.socket.write(Buffer.concat([head, text]));
    const deadline = Date.now() + timeoutMs;
    const rows: Array<Array<string | null>> = [];
    let error: string | undefined;
    for (;;) {
      const { type, body } = await this.message(deadline);
      if (type === "E") error = PgClient.errorText(body);
      if (type === "D") {
        const row: Array<string | null> = [];
        let off = 2;
        for (let c = 0; c < body.readInt16BE(0); c++) {
          const len = body.readInt32BE(off);
          off += 4;
          row.push(len < 0 ? null : body.subarray(off, off + len).toString("utf8"));
          off += Math.max(len, 0);
        }
        rows.push(row);
      }
      if (type === "Z") {
        if (error !== undefined) throw new Error(`query failed: ${error}`);
        return rows;
      }
    }
  }

  close(): void {
    const terminate = Buffer.alloc(5);
    terminate.write("X", 0);
    terminate.writeInt32BE(4, 1);
    this.socket.end(terminate);
  }
}

// ── the entrypoint ───────────────────────────────────────────────────────────

describe("entrypoint-pglite.sh: the PGlite server on loopback, the forwarder on DB_PORT", () => {
  test(
    "a non-loopback client runs queries through DB_PORT, a 4 MB result arrives intact; SIGTERM stops both (143)",
    async () => {
      const ep = await startEntrypoint();
      // DB_PORT must not accept before the server does: the kernel's readiness
      // wait counts a bare TCP accept as "the database is up".
      expect(ep.firstAccept.forwarder).toBeGreaterThanOrEqual(ep.firstAccept.server);

      const client = await PgClient.connect(EXTERNAL_IPV4!, ep.dbPort);
      await client.startup(PGLITE_BOOT_MS);
      expect(await client.query("SELECT 41 + 1 AS answer", 30_000)).toEqual([["42"]]);
      const [[big]] = (await client.query("SELECT repeat('ab', 2000000) AS big", 60_000)) as [[string]];
      expect(big.length).toBe(4_000_000);
      expect(big === "ab".repeat(2_000_000)).toBe(true);
      expect(await client.query("SELECT 'after the big one'", 30_000)).toEqual([["after the big one"]]);
      client.close();

      expect(await healthcheck(ep.dbPort)).toBe(0);

      ep.run.proc.kill("SIGTERM");
      expect(await ep.run.exitWithin(15_000)).toBe(143);
      expect(alive(ep.serverPid)).toBe(false);
      expect(alive(ep.forwarderPid)).toBe(false);
      expect(ep.run.output).toContain("SIGTERM: stopping the server and the forwarder");
    },
    PGLITE_BOOT_MS * 2,
  );

  test(
    "SIGINT stops both processes and the script exits 130",
    async () => {
      const ep = await startEntrypoint();
      ep.run.proc.kill("SIGINT");
      expect(await ep.run.exitWithin(15_000)).toBe(130);
      expect(alive(ep.serverPid)).toBe(false);
      expect(alive(ep.forwarderPid)).toBe(false);
    },
    PGLITE_BOOT_MS * 2,
  );

  test(
    "when the PGlite server dies, the forwarder is stopped and the script exits non-zero",
    async () => {
      const ep = await startEntrypoint();
      process.kill(ep.serverPid, "SIGKILL");
      const code = await ep.run.exitWithin(15_000);
      expect(code).not.toBe("timeout");
      expect(code).not.toBe(0);
      expect(alive(ep.forwarderPid)).toBe(false);
      expect(ep.run.output).toContain("the server exited");
      expect(await accepts(EXTERNAL_IPV4!, ep.dbPort, 200)).toBe(false);
    },
    PGLITE_BOOT_MS * 2,
  );

  test(
    "when the forwarder dies, the PGlite server is stopped and the script exits non-zero",
    async () => {
      const ep = await startEntrypoint();
      process.kill(ep.forwarderPid, "SIGKILL");
      const code = await ep.run.exitWithin(15_000);
      expect(code).not.toBe("timeout");
      expect(code).not.toBe(0);
      expect(alive(ep.serverPid)).toBe(false);
      expect(ep.run.output).toContain("the forwarder exited");
      expect(await accepts("127.0.0.1", ep.loopbackPort, 200)).toBe(false);
    },
    PGLITE_BOOT_MS * 2,
  );

  test("PGLITE_LOOPBACK_PORT equal to DB_PORT exits 78 before starting anything", async () => {
    const run = new Proc([BASH, join(binDir, "entrypoint-pglite.sh")], {
      PATH: `${dirname(BUN)}:/usr/bin:/bin`,
      HOME: scratch,
      REPO_ROOT,
      PGLITE_DATA_DIR: join(scratch, "unused"),
      DB_PORT: "5432",
      PGLITE_LOOPBACK_PORT: "5432",
    });
    expect(await run.exitWithin(15_000)).toBe(78);
    expect(run.output).toContain("PGLITE_LOOPBACK_PORT must differ from DB_PORT");
    expect(run.output).not.toContain("server pid");
  }, QUICK_MS);
});

// ── the healthcheck and the forwarder on their own ──────────────────────────

describe("pglite-healthcheck.ts", () => {
  test("fails for a Postgres server bound to loopback only, passes once it is reachable from outside", async () => {
    const port = await freePort();
    await sslResponder("127.0.0.1", port);
    expect(await sslAnswer("127.0.0.1", port)).toBe("N"); // it does answer, on loopback
    expect(await healthcheck(port)).toBe(1);

    const open = await freePort();
    await sslResponder("0.0.0.0", open);
    expect(await healthcheck(open)).toBe(0);
  }, QUICK_MS);

  test("fails through a forwarder whose server is down, passes once the server answers", async () => {
    const dbPort = await freePort();
    const upstream = await freePort();
    new Proc([BUN, join(binDir, "pglite-forwarder.ts"), String(dbPort), String(upstream)], {
      PATH: `${dirname(BUN)}:/usr/bin:/bin`,
      HOME: scratch,
    });
    expect(await accepts(EXTERNAL_IPV4!, dbPort, 15_000)).toBe(true);
    expect(await healthcheck(dbPort)).toBe(1);

    await sslResponder("127.0.0.1", upstream);
    expect(await healthcheck(dbPort)).toBe(0);
  }, QUICK_MS);
});

describe("pglite-forwarder.ts", () => {
  const env = () => ({ PATH: `${dirname(BUN)}:/usr/bin:/bin`, HOME: scratch });

  test("relays bytes both ways and passes a server-side close on to the client", async () => {
    const dbPort = await freePort();
    const upstream = await freePort();
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", (d: Buffer) => socket.end(Buffer.concat([Buffer.from("echo:"), d])));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(upstream, "127.0.0.1", () => r()));
    new Proc([BUN, join(binDir, "pglite-forwarder.ts"), String(dbPort), String(upstream)], env());
    expect(await accepts(EXTERNAL_IPV4!, dbPort, 15_000)).toBe(true);

    const result = await new Promise<{ data: string; closed: boolean }>((r) => {
      let data = "";
      const s = net.connect({ host: EXTERNAL_IPV4!, port: dbPort });
      const timer = setTimeout(() => {
        s.destroy();
        r({ data, closed: false });
      }, 5_000);
      s.once("connect", () => s.write("ping"));
      s.on("data", (d: Buffer) => (data += d.toString("utf8")));
      s.on("error", () => {});
      s.once("close", () => {
        clearTimeout(timer);
        r({ data, closed: true });
      });
    });
    expect(result).toEqual({ data: "echo:ping", closed: true });
  }, QUICK_MS);

  test("exits 1 when its listen port is taken", async () => {
    const taken = await freePort();
    const holder = net.createServer();
    servers.push(holder);
    await new Promise<void>((r) => holder.listen(taken, "0.0.0.0", () => r()));
    const run = new Proc([BUN, join(binDir, "pglite-forwarder.ts"), String(taken), "1"], env());
    expect(await run.exitWithin(15_000)).toBe(1);
    expect(run.output).toContain(`listener 0.0.0.0:${taken}`);
  }, QUICK_MS);

  test("exits 64 when an argument is not a TCP port", async () => {
    const run = new Proc([BUN, join(binDir, "pglite-forwarder.ts"), "5432", "not-a-port"], env());
    expect(await run.exitWithin(15_000)).toBe(64);
    expect(run.output).toContain("upstream port must be a TCP port");
  }, QUICK_MS);
});
