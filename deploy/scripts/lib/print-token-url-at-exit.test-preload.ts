// Test support for entry-log-redaction.test.ts, loaded with `bun --preload`.
//
// Stands in for a dependency that prints the URL of a connection it lost (the
// wallet SDK's RPC client does, query string included). When the process
// exits it prints a Blockfrost URL carrying LOG_GUARD_TEST_TOKEN through
// console.log, console.error and a raw stderr write. By then the entry under
// test has run its top level, so each line shows whether that entry installed
// the process-wide log guard before reaching its exit.

const token = process.env["LOG_GUARD_TEST_TOKEN"] ?? "";
const url = `wss://rpc.midnight-preprod.blockfrost.io/?project_id=${token}`;

process.on("exit", () => {
  console.log(`API-WS: disconnected from ${url}`);
  console.error(new Error(`connection lost: ${url}`));
  process.stderr.write(`raw write ${url}\n`);
});
