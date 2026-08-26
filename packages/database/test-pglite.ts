/** Minimal structural types keep the test helper independent from the
 * implementation package that owns startPglite. */
export interface TestPgliteHandle {
  server: {
    listening?: boolean;
    close: (callback: (error?: Error & { code?: string }) => void) => unknown;
  };
  db: { close: () => Promise<void> };
}

export interface TestPgClient {
  end: () => Promise<void>;
}

const closing = new WeakMap<object, Promise<void>>();

function closeServer(handle: TestPgliteHandle): Promise<void> {
  if (handle.server.listening === false) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    try {
      handle.server.close((error) => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
    } catch (error: any) {
      if (error?.code === "ERR_SERVER_NOT_RUNNING") resolve();
      else reject(error);
    }
  });
}

/**
 * Shut down pg-gateway before its PGlite WASM backend. The pinned
 * startPglite.close() starts closing the TCP server but does not await it, so a
 * client's final Terminate frame can otherwise reach an already-closed WASM
 * instance and print a late call_indirect RuntimeError after green tests.
 *
 * The operation is idempotent and best-effort: every stage is attempted, then
 * any cleanup errors are surfaced together instead of hiding earlier ones.
 */
export function closeTestPglite(
  handle: TestPgliteHandle | null | undefined,
  client: TestPgClient | null | undefined,
): Promise<void> {
  const owner = (handle ?? client) as object | undefined;
  if (!owner) return Promise.resolve();
  const existing = closing.get(owner);
  if (existing) return existing;

  const operation = (async () => {
    const errors: unknown[] = [];
    if (client) {
      try { await client.end(); } catch (error) { errors.push(error); }
    }
    if (handle) {
      try { await closeServer(handle); } catch (error) { errors.push(error); }
      try { await handle.db.close(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "PGlite test teardown failed");
    }
  })();
  closing.set(owner, operation);
  return operation;
}
