/** Minimal structural types keep the test helper independent from the
 * implementation package that owns startPglite. */
export interface TestPgliteHandle {
  close: (options?: { force?: boolean }) => Promise<void>;
}

export interface TestPgClient {
  end: () => Promise<void>;
}

const closing = new WeakMap<object, Promise<void>>();

/**
 * End the owned pg client, then let startPglite drain its serialized protocol
 * queue before it closes the PGlite WASM backend. Closing the public server and
 * db fields directly can race a client's final Terminate frame with db.close().
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
      try { await handle.close({ force: true }); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "PGlite test teardown failed");
    }
  })();
  closing.set(owner, operation);
  return operation;
}
