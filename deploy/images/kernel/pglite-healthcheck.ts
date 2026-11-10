// pglite-healthcheck.ts — the pglite service's Compose healthcheck.
//
// It connects the way other containers do: to this container's own
// non-loopback IPv4 address on DB_PORT, which is the forwarder (see
// entrypoint-pglite.sh), never to 127.0.0.1, where the PGlite server itself
// listens. It sends a Postgres SSLRequest; the server answers with one byte
// ('N' = no TLS, 'S' = TLS), so a reply proves that the forwarder accepts and
// that the server behind it answers. A bare TCP accept proves neither.
//
// Exit 0 = healthy, 1 = not.
import net from "node:net";
import { networkInterfaces } from "node:os";

const port = Number(process.env["DB_PORT"] ?? "5432");
// Int32 length 8, then the SSLRequest code 80877103 (0x04d2162f).
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);
const ANSWERS = new Set([0x4e, 0x53]); // 'N', 'S'
const TIMEOUT_MS = 4_000;

const address = Object.values(networkInterfaces())
  .flat()
  .find((iface) => iface !== undefined && iface.family === "IPv4" && !iface.internal)?.address;

if (address === undefined) {
  console.error("[pglite-healthcheck] this container has no non-loopback IPv4 address");
  process.exit(1);
}

const answer = await new Promise<number | undefined>((resolve) => {
  const socket = net.connect({ host: address, port });
  const finish = (value: number | undefined) => {
    clearTimeout(timer);
    socket.destroy();
    resolve(value);
  };
  const timer = setTimeout(() => finish(undefined), TIMEOUT_MS);
  socket.once("connect", () => socket.write(SSL_REQUEST));
  socket.once("data", (data: Buffer) => finish(data[0]));
  socket.once("error", () => finish(undefined));
  socket.once("close", () => finish(undefined));
});

if (answer !== undefined && ANSWERS.has(answer)) process.exit(0);
console.error(`[pglite-healthcheck] no Postgres answer from ${address}:${port}`);
process.exit(1);
