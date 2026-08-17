/** L5-only HTTP recorder between the real relay puller and Offer Files API. */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.env.LINEAGE_RECORDER_PORT ?? "8082");
const upstream = new URL(process.env.LINEAGE_RECORDER_UPSTREAM ?? "http://127.0.0.1:8080");
const evidencePath = process.env.LINEAGE_UPSTREAM_EVIDENCE_PATH;
if (!evidencePath) throw new Error("LINEAGE_UPSTREAM_EVIDENCE_PATH is required");
if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
  throw new Error("LINEAGE_RECORDER_PORT must be a valid TCP port");
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function record(value) {
  appendFileSync(
    evidencePath,
    `${JSON.stringify({ observedAt: new Date().toISOString(), ...value })}\n`,
    "utf8",
  );
}

function send(response, status, bytes, contentType = "application/json") {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": String(bytes.byteLength),
    "cache-control": "no-store",
  });
  response.end(bytes);
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.byteLength;
    if (length > 1_048_576) throw new Error("request body exceeds recorder limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  const requestId = randomUUID();
  try {
    if (request.method === "GET" && request.url === "/__recorder/ready") {
      return send(response, 200, Buffer.from('{"ready":true}'));
    }

    const requestBody = await readBody(request);
    const authorization = request.headers.authorization;
    record({
      requestId,
      phase: "request",
      method: request.method,
      path: request.url,
      authorizationPresent: authorization !== undefined,
      authorizationSha256: authorization === undefined
        ? null
        : sha256(Buffer.from(authorization)),
      bodyBytes: requestBody.byteLength,
      bodySha256: sha256(requestBody),
      bodyBase64: requestBody.toString("base64"),
    });

    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || name === "host" || name === "content-length") continue;
      headers.set(name, Array.isArray(value) ? value.join(",") : value);
    }
    const target = new URL(request.url ?? "/", upstream);
    const upstreamResponse = await fetch(target, {
      method: request.method,
      headers,
      body: requestBody.byteLength === 0 || request.method === "GET" || request.method === "HEAD"
        ? undefined
        : requestBody,
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
    record({
      requestId,
      phase: "response",
      method: request.method,
      path: request.url,
      status: upstreamResponse.status,
      contentType: upstreamResponse.headers.get("content-type"),
      cacheControl: upstreamResponse.headers.get("cache-control"),
      bodyBytes: responseBody.byteLength,
      bodySha256: sha256(responseBody),
      bodyBase64: responseBody.toString("base64"),
    });
    return send(
      response,
      upstreamResponse.status,
      responseBody,
      upstreamResponse.headers.get("content-type") ?? "application/octet-stream",
    );
  } catch (error) {
    const body = Buffer.from(JSON.stringify({
      error: "recorder_proxy_error",
      message: error instanceof Error ? error.message : String(error),
    }));
    record({
      requestId,
      phase: "response",
      method: request.method,
      path: request.url,
      status: 502,
      bodyBytes: body.byteLength,
      bodySha256: sha256(body),
      bodyBase64: body.toString("base64"),
    });
    return send(response, 502, body);
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "lineage-upstream-recorder-ready", port }));
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
