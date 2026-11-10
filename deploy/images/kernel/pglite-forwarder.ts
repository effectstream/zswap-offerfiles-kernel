// pglite-forwarder.ts — serves the pglite container's database port on every
// interface and relays each connection, byte for byte, to the PGlite server on
// the container's loopback interface.
//
// Why: `@effectstream/db`'s `start-pglite` binds 127.0.0.1 and has no option to
// bind another address, so neither another container (the kernel, the
// price-feed) nor the published host port can reach it directly. Once that
// server can bind a non-loopback address, run it on DB_PORT and remove this
// forwarder.
//
// Usage: bun pglite-forwarder.ts <listen-port> <upstream-port>
//   listens on 0.0.0.0:<listen-port>, relays to 127.0.0.1:<upstream-port>.
// Exit status: 64 for a bad argument, 1 when the listener cannot be opened or
// fails later. A failed upstream connection closes only that client.
import net from "node:net";

const LISTEN_HOST = "0.0.0.0";
const UPSTREAM_HOST = "127.0.0.1";

function tcpPort(value: string | undefined, name: string): number {
  const port = Number(value);
  if (!/^[0-9]+$/.test(value ?? "") || port < 1 || port > 65535) {
    console.error(`[pglite-forwarder] ${name} must be a TCP port, got '${value ?? ""}'`);
    process.exit(64);
  }
  return port;
}

const listenPort = tcpPort(process.argv[2], "listen port");
const upstreamPort = tcpPort(process.argv[3], "upstream port");

const server = net.createServer((client) => {
  const upstream = net.connect({ host: UPSTREAM_HOST, port: upstreamPort });
  // pipe() carries the bytes with back-pressure and forwards a clean end in
  // each direction. A failure on either side resets the other; a close on
  // either side ends the other once its pending writes are flushed.
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", (err) => {
    console.error(`[pglite-forwarder] upstream ${UPSTREAM_HOST}:${upstreamPort}: ${err.message}`);
    client.destroy();
  });
  client.on("close", () => upstream.end());
  upstream.on("close", () => client.end());
});

server.on("error", (err) => {
  console.error(`[pglite-forwarder] listener ${LISTEN_HOST}:${listenPort}: ${err.message}`);
  process.exit(1);
});

server.listen(listenPort, LISTEN_HOST, () => {
  console.error(`[pglite-forwarder] ${LISTEN_HOST}:${listenPort} -> ${UPSTREAM_HOST}:${upstreamPort}`);
});
