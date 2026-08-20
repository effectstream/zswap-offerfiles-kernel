export const REAL_E1_PINS = Object.freeze({
  appBuildBunImage:
    "oven/bun:1.3.3@sha256:fbf8e67e9d3b806c86be7a2f2e9bae801f2d9212a21db4dcf8cc9889f5a3c9c4",
  appBuildBunVersion: "1.3.3",
  appRuntimeBunImage:
    "oven/bun:1.3.10@sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e",
  appRuntimeBunVersion: "1.3.10",
  appRuntimeBunRevision: "1.3.10+30e609e08",
  appRuntimeBunBinarySha256: "1edcc88fd13c16471aa29ec9d5af4063e43ec9b71d34e89cb7e43dbec718aaf0",
  celestiaBunVersion: "1.3.3",
  nodeImage:
    "node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43",
  ubuntuAmd64:
    "ubuntu@sha256:019e8eb29a85e74d64925745884f2ec79aa27e3feab36353d24656f4d6b89467",
  postgres:
    "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193",
  midnightNode:
    "midnightntwrk/midnight-node:1.0.0@sha256:ede01da35e982b6a4b85461ad8492ae2753ef14246fba33c8039b782aa8e39fb",
  midnightIndexer:
    "midnightntwrk/indexer-standalone:4.3.3@sha256:03afd079b00bcd229df29a24771439c5e7695c339cd89216d0763ce40731cc4b",
  midnightProof:
    "midnightntwrk/proof-server:8.1.0@sha256:801bbc0340e9e96f16735f77b523f23c7459e3359842f7c79c2c53f4e994d531",
  celestiaBunZipSha256: "f5c546736f955141459de231167b6fdf7b01418e8be3609f2cde9dfe46a93a3d",
  celestiaBunBinarySha256: "d83e27167fe3dddfc1203183eba920015b0ba1406c735ea0da93ae8f377c4981",
  compactInstallerSha256: "85e74a53ae4a67b31fa4d854f3b6ffb4c29f7c53e3372c5008b6a4729a8b4a73",
  compactArmManagerSha256: "33a8a67174fcd3ae4ede72aae6a1d52daf4ef7af245205edfb098d140946a794",
  compactArmArchiveSha256: "e4f36268ee652f1415d253d9fabd64a92b5eb0dc7cf28f40fa68c2445c7b3341",
  compactArmBinarySha256: "a501cc8f20fe1f4d9034204c95853dd80ba977bb77d7c4f7d5d88d4242607def",
  nodeGypVersion: "13.0.1",
  nodeGypPackageJsonSha256: "89f6a95442a6360484cc1d48b35cac8c76b0ec2f2bd1ad8132d5b707de3ed359",
  nodeGypLockSha256: "3a154ec9a1c2738f955405264a7dc581cbaee16256116e2d734a20bfacebc16e",
  celestiaAppArchiveSha256: "fa1826187a91514c6d506e22f1fcce25afbd551b98458caf899801b662a0c8da",
  celestiaNodeArchiveSha256: "bb8b9fd2ac859945fdf2f8c84ba038f75e01be54e56d1a946cbbd4b540f120d9",
  celestiaAppSha256: "48a17d6e523ec0217ea5d13948df3a44c473ebd4a2df5c4f4d5be3080a3352a3",
  celestiaNodeSha256: "3289e47299086ad9b98c2be55f096c3347b72cd32b9382f9036b3624878b84de",
  celestiaPackageJsonSha256: "29fc59516ac8964dddf80f6e0967f595d88e9c484c7afa82366f46da6706e09d",
  celestiaLockSha256: "7d7b02c122053cefbeaec904ffca20855c9b6313c41386fa8d3076ac95f22c3a",
  compactVersion: "0.30.0",
  // Acceptance devnet block cadence, matching current Celestia mainnet.
  // celestia-app 6.4.10's ONLY working block-time control is
  // `--delayed-precommit-timeout`; `timeout_commit` in config.toml is
  // deprecated and inert (measured on the pinned binary: flag 1s + config 3s
  // still produced 20 blocks in 20s, while flag 3s produced 7). At 1s the
  // ~1 block/s indexer could never stay inside the production threshold
  // MAX_CELESTIA_LAG_BLOCKS = 4 — see e2e open question E1-Q4.
  celestiaBlockTime: "3s",
  celestiaPackageVersion: "0.103.1",
  celestiaAppVersion: "6.4.10",
  celestiaNodeVersion: "0.28.4",
} as const);

export const REAL_E1_PROOF_START_MARKER_PREFIX = "E1_PROOF_LOG_START:";
export const REAL_E1_PROOF_ENTRYPOINT =
  "/nix/store/cb222yvvz4fx671vvh7i9lb9p8bmpgnh-bash-interactive-aarch64-unknown-linux-musl-5.3p9/bin/bash";
export const REAL_E1_PROOF_STAT =
  "/nix/store/63mczpykd3lpmgiff51b0q4w8jrmx2cl-coreutils-aarch64-unknown-linux-musl-9.10/bin/stat";
export const REAL_E1_PROOF_COMMAND =
  `printf 'E1_PROOF_LOG_START:%s\\n' "$E1_PROOF_LOG_MARKER" && exec /nix/store/36gqmsz0q11c9ysxjvi3wbcdh4vkcv5q-ledger-8.1.0/bin/midnight-proof-server --port 6300`;
export const REAL_E1_PROOF_COMPOSE_COMMAND = REAL_E1_PROOF_COMMAND.replaceAll("$", () => "$$");

const COMPLETE_LOGGING = `logging: &complete-service-logging
  driver: json-file
  options:
    mode: "blocking"`;
const PROOF_LOGGING = `logging: &proof-service-logging
  driver: local
  options:
    max-size: "8m"
    max-file: "1"
    compress: "false"
    mode: "blocking"`;
const USE_COMPLETE_LOGGING = "logging: *complete-service-logging";
const USE_PROOF_LOGGING = "logging: *proof-service-logging";

const quoteYaml = (value: string): string => JSON.stringify(value);

export function realE1AppDockerfile(): string {
  return `FROM --platform=linux/arm64 ${REAL_E1_PINS.appRuntimeBunImage} AS app-bun-runtime
FROM --platform=linux/arm64 ${REAL_E1_PINS.appBuildBunImage} AS app-build
USER root
ENV PATH=/root/.local/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN apt-get update \\
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      ca-certificates=20250419~deb12u1 curl=7.88.1-10+deb12u15 unzip=6.0-28 \\
      xz-utils=5.4.1-1+deb12u1 openssl=3.0.20-1~deb12u2 python3=3.11.2-1+b1 \\
      make=4.3-4.1 g++=4:12.2.0-3 libnode-dev=18.20.4+dfsg-1~deb12u2 \\
 && dpkg-query -W | LC_ALL=C sort > /opt/zswap-dpkg-manifest.txt \\
 && apt-get clean \\
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/node-gyp
COPY source/packages/tests/grand-e2e/lib/solver-offerfiles-node-gyp.package.json package.json
COPY source/packages/tests/grand-e2e/lib/solver-offerfiles-node-gyp.bun.lock bun.lock
RUN set -eux; \\
    echo '${REAL_E1_PINS.nodeGypPackageJsonSha256}  package.json' | sha256sum -c -; \\
    echo '${REAL_E1_PINS.nodeGypLockSha256}  bun.lock' | sha256sum -c -; \\
    bun install --frozen-lockfile --ignore-scripts; \\
    echo '${REAL_E1_PINS.nodeGypLockSha256}  bun.lock' | sha256sum -c -; \\
    test "$(./node_modules/.bin/node-gyp --version)" = 'v${REAL_E1_PINS.nodeGypVersion}'
WORKDIR /work
COPY source/ /work/
RUN set -eux; \\
    test "$(/opt/node-gyp/node_modules/.bin/node-gyp --version)" = 'v${REAL_E1_PINS.nodeGypVersion}'; \\
    PATH=/opt/node-gyp/node_modules/.bin:$PATH npm_config_nodedir=/usr \\
      bun install --frozen-lockfile --concurrent-scripts=1 2>&1 | tee /tmp/bun-install.log; \\
    grep -E '(2235 packages installed|Installed 2235 packages)' /tmp/bun-install.log; \\
    rm -f /tmp/bun-install.log
RUN set -eux; \\
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --connect-timeout 15 --max-time 180 \\
      -o /tmp/compact-installer.sh \\
      https://github.com/midnightntwrk/compact/releases/download/compact-v0.5.1/compact-installer.sh; \\
    echo '${REAL_E1_PINS.compactInstallerSha256}  /tmp/compact-installer.sh' | sha256sum -c -; \\
    sh /tmp/compact-installer.sh; \\
    echo '${REAL_E1_PINS.compactArmManagerSha256}  /root/.local/bin/compact' | sha256sum -c -; \\
    test "$(/root/.local/bin/compact --version)" = 'compact 0.5.1'; \\
    /root/.local/bin/compact update ${REAL_E1_PINS.compactVersion}; \\
    artifact="$(find /root/.compact/versions/${REAL_E1_PINS.compactVersion} -name artifact.zip -type f -print -quit)"; \\
    compiler="$(find /root/.compact/versions/${REAL_E1_PINS.compactVersion} -name compactc.bin -type f -print -quit)"; \\
    test -n "$artifact"; \\
    test -n "$compiler"; \\
    echo '${REAL_E1_PINS.compactArmArchiveSha256}  '"$artifact" | sha256sum -c -; \\
    echo '${REAL_E1_PINS.compactArmBinarySha256}  '"$compiler" | sha256sum -c -; \\
    test "$(/root/.local/bin/compact compile +${REAL_E1_PINS.compactVersion} --version)" = '${REAL_E1_PINS.compactVersion}'; \\
    rm -f /tmp/compact-installer.sh
RUN set -eux; \\
    bun run --filter @zswap-da/contract-offer-files compact; \\
    managed='packages/contracts-midnight/contract-offer-files/src/managed'; \\
    for path in \\
      compiler/contract-info.json \\
      contract/index.d.ts contract/index.js contract/index.js.map \\
      keys/incrementNoun.prover keys/incrementNoun.verifier \\
      keys/mint_shielded.prover keys/mint_shielded.verifier \\
      keys/mint_unshielded.prover keys/mint_unshielded.verifier \\
      zkir/incrementNoun.bzkir zkir/incrementNoun.zkir \\
      zkir/mint_shielded.bzkir zkir/mint_shielded.zkir \\
      zkir/mint_unshielded.bzkir zkir/mint_unshielded.zkir; \\
    do test -f "$managed/$path"; done; \\
    test "$(find "$managed/keys" -type f | wc -l | tr -d ' ')" = '6'; \\
    test "$(find "$managed/zkir" -type f | wc -l | tr -d ' ')" = '6'
RUN set -eux; \\
    test "$(bun --version)" = '${REAL_E1_PINS.appBuildBunVersion}'; \\
    printf '%s\\n' '${REAL_E1_PINS.appBuildBunVersion}' > /opt/zswap-app-build-bun-version.txt
FROM app-build AS app-runtime
COPY --from=app-bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN set -eux; \\
    echo '${REAL_E1_PINS.appRuntimeBunBinarySha256}  /usr/local/bin/bun' | sha256sum -c -; \\
    test "$(bun --version)" = '${REAL_E1_PINS.appRuntimeBunVersion}'; \\
    test "$(bun --revision)" = '${REAL_E1_PINS.appRuntimeBunRevision}'; \\
    test "$(command -v bun)" = '/usr/local/bin/bun'; \\
    test "$(printf '%s\\n' "$PATH" | tr ':' '\\n' | while IFS= read -r directory; do test -n "$directory" || directory=.; test ! -x "$directory/bun" || readlink -f "$directory/bun"; done | LC_ALL=C sort -u)" = '/usr/local/bin/bun'
LABEL org.zswap.e1.role="native-app-toolchain" \\
      org.zswap.e1.app-build-bun-image="${REAL_E1_PINS.appBuildBunImage}" \\
      org.zswap.e1.app-build-bun="${REAL_E1_PINS.appBuildBunVersion}" \\
      org.zswap.e1.app-runtime-bun-image="${REAL_E1_PINS.appRuntimeBunImage}" \\
      org.zswap.e1.app-runtime-bun="${REAL_E1_PINS.appRuntimeBunVersion}" \\
      org.zswap.e1.app-runtime-bun-revision="${REAL_E1_PINS.appRuntimeBunRevision}" \\
      org.zswap.e1.app-runtime-bun-sha256="${REAL_E1_PINS.appRuntimeBunBinarySha256}" \\
      org.zswap.e1.compact="${REAL_E1_PINS.compactVersion}"
`;
}

export function realE1CelestiaDockerfile(): string {
  return `FROM --platform=linux/amd64 ${REAL_E1_PINS.ubuntuAmd64}
ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN apt-get update \\
 && apt-get install -y --no-install-recommends \\
      ca-certificates=20260601~24.04.1 curl=8.5.0-2ubuntu10.11 \\
      unzip=6.0-28ubuntu4.1 xz-utils=5.6.1+really5.4.5-1ubuntu0.3 \\
      libstdc++6=14.2.0-4ubuntu2~24.04.1 \\
 && dpkg-query -W | LC_ALL=C sort > /opt/zswap-dpkg-manifest.txt \\
 && apt-get clean \\
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \\
    curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 \\
      -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.3.3/bun-linux-x64.zip; \\
    echo '${REAL_E1_PINS.celestiaBunZipSha256}  /tmp/bun.zip' | sha256sum -c -; \\
    unzip -q /tmp/bun.zip -d /tmp/bun; \\
    install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun; \\
    echo '${REAL_E1_PINS.celestiaBunBinarySha256}  /usr/local/bin/bun' | sha256sum -c -; \\
    test "$(bun --version)" = '${REAL_E1_PINS.celestiaBunVersion}'; \\
    rm -rf /tmp/bun /tmp/bun.zip
WORKDIR /opt/celestia
COPY package.json bun.lock ./
RUN set -eux; \\
    echo '${REAL_E1_PINS.celestiaPackageJsonSha256}  package.json' | sha256sum -c -; \\
    echo '${REAL_E1_PINS.celestiaLockSha256}  bun.lock' | sha256sum -c -; \\
    timeout 240 bun install --frozen-lockfile --ignore-scripts; \\
    echo '${REAL_E1_PINS.celestiaLockSha256}  bun.lock' | sha256sum -c -
RUN set -eux; \\
    mkdir -p /opt/celestia/node_modules/@effectstream/celestia/vendor; \\
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --connect-timeout 15 --max-time 300 \\
      -o /tmp/celestia-app.tar.gz \\
      https://github.com/effectstream/binaries/releases/download/0.3.120/celestia-appd-linux-amd64-v${REAL_E1_PINS.celestiaAppVersion}.tar.gz; \\
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --connect-timeout 15 --max-time 300 \\
      -o /tmp/celestia-node.tar.gz \\
      https://github.com/effectstream/binaries/releases/download/0.3.120/celestia-node-linux-amd64-v${REAL_E1_PINS.celestiaNodeVersion}.tar.gz; \\
    echo '${REAL_E1_PINS.celestiaAppArchiveSha256}  /tmp/celestia-app.tar.gz' | sha256sum -c -; \\
    echo '${REAL_E1_PINS.celestiaNodeArchiveSha256}  /tmp/celestia-node.tar.gz' | sha256sum -c -; \\
    tar -xzf /tmp/celestia-app.tar.gz -C /opt/celestia/node_modules/@effectstream/celestia/vendor celestia-appd; \\
    tar -xzf /tmp/celestia-node.tar.gz -C /opt/celestia/node_modules/@effectstream/celestia/vendor celestia; \\
    echo '${REAL_E1_PINS.celestiaAppSha256}  /opt/celestia/node_modules/@effectstream/celestia/vendor/celestia-appd' | sha256sum -c -; \\
    echo '${REAL_E1_PINS.celestiaNodeSha256}  /opt/celestia/node_modules/@effectstream/celestia/vendor/celestia' | sha256sum -c -; \\
    vendor=/opt/celestia/node_modules/@effectstream/celestia/vendor; \\
    mv "$vendor/celestia-appd" "$vendor/celestia-appd.real"; \\
    { \\
      echo '#!/bin/sh'; \\
      echo '# Pass-through shim over the content-pinned celestia-appd.'; \\
      echo '# @effectstream/celestia starts the node with a hardcoded'; \\
      echo '# --delayed-precommit-timeout 1s. On 6.4.10 that flag is the ONLY'; \\
      echo '# working block-time control (timeout_commit is deprecated and'; \\
      echo '# inert, measured). pflag keeps the LAST occurrence, so appending'; \\
      echo '# ours on the start subcommand wins without editing the dep.'; \\
      echo '# Every other subcommand passes through untouched.'; \\
      echo 'if [ "$1" = "start" ]; then'; \\
      echo '  exec "$0.real" "$@" --delayed-precommit-timeout ${REAL_E1_PINS.celestiaBlockTime}'; \\
      echo 'fi'; \\
      echo 'exec "$0.real" "$@"'; \\
    } > "$vendor/celestia-appd"; \\
    chmod 0755 "$vendor/celestia-appd"; \\
    /opt/celestia/node_modules/@effectstream/celestia/vendor/celestia-appd version | grep -F '${REAL_E1_PINS.celestiaAppVersion}'; \\
    /opt/celestia/node_modules/@effectstream/celestia/vendor/celestia version | grep -F '${REAL_E1_PINS.celestiaNodeVersion}'; \\
    ldd --version 2>&1 | grep -F '2.39'; \\
    rm -f /tmp/celestia-app.tar.gz /tmp/celestia-node.tar.gz
ENV CELESTIA_HOME=/tmp/celestia-e1-home
ENV CELESTIA_FORCE_NO_BBR=1
HEALTHCHECK --interval=2s --timeout=5s --start-period=20s --retries=90 \\
  CMD curl -fsS -X POST -H 'content-type: application/json' \\
      --data '{"jsonrpc":"2.0","id":1,"method":"header.NetworkHead","params":[]}' \\
      http://127.0.0.1:26658 | grep -q '"result"' || exit 1
LABEL org.zswap.e1.role="celestia-amd64-wrapper" \\
      org.zswap.e1.celestia-bun="${REAL_E1_PINS.celestiaBunVersion}" \\
      org.zswap.e1.celestia-bun-sha256="${REAL_E1_PINS.celestiaBunBinarySha256}" \\
      org.zswap.e1.celestia-app="${REAL_E1_PINS.celestiaAppVersion}" \\
      org.zswap.e1.celestia-node="${REAL_E1_PINS.celestiaNodeVersion}"
CMD ["bun", "/opt/celestia/node_modules/@effectstream/celestia/index.js", "start-bridge", "--verbose"]
`;
}

export interface RealE1ComposeInput {
  appImage: string;
  celestiaImage: string;
  serviceSource: string;
  trafficPath: string;
  proofLogMarker: string;
}

export function realE1ComposeSource(input: RealE1ComposeInput): string {
  const source = quoteYaml(input.serviceSource);
  const traffic = quoteYaml(input.trafficPath);
  const healthcheck = quoteYaml(
    "fetch('http://127.0.0.1:8080/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
  );
  const dependencyProbes = quoteYaml(JSON.stringify([
    { kind: "tcp", host: "postgres", port: 5432 },
    {
      kind: "http",
      url: "http://midnight-node:9944",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "chain_getBlockHash", params: [1] }),
      includes: '"result":"0x',
    },
    {
      kind: "http",
      url: "http://midnight-indexer:8088/api/v3/graphql",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query { __typename }" }),
      includes: '"data"',
    },
    { kind: "tcp", host: "proof-server", port: 6300 },
    {
      kind: "http",
      url: "http://celestia-proxy:8080",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "header.NetworkHead", params: [] }),
      includes: '"result"',
    },
  ]));

  return `x-complete-logging:
  ${COMPLETE_LOGGING.replaceAll("\n", "\n  ")}

x-proof-logging:
  ${PROOF_LOGGING.replaceAll("\n", "\n  ")}

x-harness-service: &harness-service
  image: ${REAL_E1_PINS.nodeImage}
  pull_policy: missing
  command: ["node", "/opt/harness/service.mjs"]
  restart: "no"
  init: true
  ${USE_COMPLETE_LOGGING}
  volumes:
    - type: bind
      source: ${source}
      target: /opt/harness/service.mjs
      read_only: true
  healthcheck:
    test: ["CMD", "node", "-e", ${healthcheck}]
    interval: 2s
    timeout: 2s
    retries: 120
    start_period: 2s

services:
  traffic-recorder:
    <<: *harness-service
    environment:
      HARNESS_ROLE: collector
      HARNESS_CHANNEL: recorder
      HARNESS_TRAFFIC_PATH: /opt/harness/traffic.jsonl
    volumes:
      - type: bind
        source: ${source}
        target: /opt/harness/service.mjs
        read_only: true
      - type: bind
        source: ${traffic}
        target: /opt/harness/traffic.jsonl
    ports:
      - "127.0.0.1:\${RECORDER_HOST_PORT:?RECORDER_HOST_PORT must be set}:8080"
    networks: [control, host_access]

  postgres:
    image: ${REAL_E1_PINS.postgres}
    pull_policy: missing
    platform: linux/arm64
    restart: "no"
    ${USE_COMPLETE_LOGGING}
    environment:
      POSTGRES_USER: postgres
      POSTGRES_DB: postgres
      POSTGRES_PASSWORD: "\${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d postgres"]
      interval: 2s
      timeout: 3s
      retries: 60
      start_period: 2s
    tmpfs:
      - /var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=536870912,uid=70,gid=70,mode=0700
      - /var/run/postgresql:rw,nosuid,nodev,noexec,size=16777216,uid=70,gid=70,mode=3777
    networks: [offerfiles_private]

  midnight-node:
    image: ${REAL_E1_PINS.midnightNode}
    pull_policy: missing
    platform: linux/arm64
    restart: "no"
    ${USE_COMPLETE_LOGGING}
    cap_drop: [ALL]
    cap_add: [CHOWN, DAC_OVERRIDE, FOWNER]
    security_opt: ["no-new-privileges:true"]
    environment:
      CFG_PRESET: dev
      SIDECHAIN_BLOCK_BENEFICIARY: "04bcf7ad3be7a5c790460be82a713af570f22e0f801f6659ab8e84a52be6969e"
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          curl -fs -H 'Content-Type: application/json'
          -d '{"id":1,"jsonrpc":"2.0","method":"chain_getBlockHash","params":[1]}'
          http://127.0.0.1:9944 | grep -q '"result":"0x'
      interval: 2s
      timeout: 5s
      retries: 60
      start_period: 5s
    tmpfs:
      - /node/chain:rw,nosuid,nodev,noexec,size=1073741824,uid=0,gid=0,mode=0700
    networks: [midnight_private]

  midnight-indexer:
    image: ${REAL_E1_PINS.midnightIndexer}
    pull_policy: missing
    platform: linux/arm64
    restart: "no"
    ${USE_COMPLETE_LOGGING}
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    depends_on:
      midnight-node: { condition: service_healthy }
    environment:
      RUST_LOG: "indexer=info,chain_indexer=info,indexer_api=info,wallet_indexer=info,indexer_common=info,fastrace_opentelemetry=off,info"
      APP__APPLICATION__NETWORK_ID: undeployed
      APP__INFRA__NODE__URL: ws://midnight-node:9944
      APP__INFRA__STORAGE__PASSWORD: indexer
      APP__INFRA__PUB_SUB__PASSWORD: indexer
      APP__INFRA__LEDGER_STATE_STORAGE__PASSWORD: indexer
      APP__INFRA__SECRET: "\${MIDNIGHT_INDEXER_SECRET:?MIDNIGHT_INDEXER_SECRET must be set}"
      APP__INFRA__SPO_NODE__URL: ws://midnight-node:9944
      APP__INFRA__SPO_NODE__BLOCKFROST_ID: e1-test-dummy-id
    healthcheck:
      test: ["CMD-SHELL", "cat /var/run/indexer-standalone/running"]
      interval: 5s
      timeout: 5s
      retries: 36
      start_period: 60s
    tmpfs:
      - /data:rw,nosuid,nodev,noexec,size=536870912,uid=10001,gid=10001,mode=0700
      - /var/run/indexer-standalone:rw,nosuid,nodev,noexec,size=16777216,uid=10001,gid=10001,mode=0700
    networks: [midnight_private]

  proof-server:
    image: ${REAL_E1_PINS.midnightProof}
    pull_policy: missing
    platform: linux/arm64
    restart: "no"
    ${USE_PROOF_LOGGING}
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    command: [${quoteYaml(REAL_E1_PROOF_COMPOSE_COMMAND)}]
    environment:
      E1_PROOF_LOG_MARKER: ${quoteYaml(input.proofLogMarker)}
      RUST_LOG: info
      RUST_BACKTRACE: "0"
      MIDNIGHT_PROOF_SERVER_VERBOSE: "false"
    tmpfs:
      - /.cache/midnight/zk-params:rw,nosuid,nodev,noexec,size=1073741824,uid=0,gid=0,mode=0700
    networks: [midnight_private, proof_egress]

  app-toolchain-check:
    image: ${input.appImage}
    pull_policy: never
    platform: linux/arm64
    restart: "no"
    ${USE_COMPLETE_LOGGING}
    command:
      - bash
      - -c
      - >-
        test "$$(bun --version)" = "${REAL_E1_PINS.appRuntimeBunVersion}" &&
        test "$$(/root/.local/bin/compact --version)" = "compact 0.5.1" &&
        test "$$(/root/.local/bin/compact compile +${REAL_E1_PINS.compactVersion} --version)" = "${REAL_E1_PINS.compactVersion}" &&
        bunx orchestrator list --config packages/tests/start.test.ts &&
        managed=packages/contracts-midnight/contract-offer-files/src/managed &&
        test -f "$$managed/compiler/contract-info.json" &&
        test -f "$$managed/contract/index.d.ts" &&
        test -f "$$managed/contract/index.js" &&
        test -f "$$managed/contract/index.js.map" &&
        test "$$(find "$$managed/keys" -type f | wc -l | tr -d ' ')" = "6" &&
        test "$$(find "$$managed/zkir" -type f | wc -l | tr -d ' ')" = "6"
    networks: [build_private]

  celestia:
    image: ${input.celestiaImage}
    pull_policy: never
    platform: linux/amd64
    restart: "no"
    init: true
    ${USE_COMPLETE_LOGGING}
    tmpfs:
      - /tmp:rw,nosuid,nodev,size=1073741824,uid=0,gid=0,mode=1777
    networks: [celestia_boundary]

  celestia-forwarder:
    <<: *harness-service
    network_mode: service:celestia
    depends_on:
      celestia: { condition: service_healthy }
    environment:
      HARNESS_ROLE: tcp-forwarder
      HARNESS_PORT: "26659"
      HARNESS_TCP_TARGET_HOST: 127.0.0.1
      HARNESS_TCP_TARGET_PORT: "26658"
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - >-
          const s=require('node:net').connect(26659,'127.0.0.1');
          const t=setTimeout(()=>process.exit(1),1500);
          s.on('connect',()=>{clearTimeout(t);s.end();process.exit(0)});
          s.on('error',()=>process.exit(1));
      interval: 2s
      timeout: 2s
      retries: 30
      start_period: 1s

  celestia-proxy:
    <<: *harness-service
    depends_on:
      traffic-recorder: { condition: service_healthy }
      celestia-forwarder: { condition: service_healthy }
    environment:
      HARNESS_ROLE: proxy
      HARNESS_CHANNEL: celestia
      HARNESS_COLLECTOR_URL: http://traffic-recorder:8080
      HARNESS_UPSTREAM_URL: http://celestia:26659
      HARNESS_UPSTREAM_TIMEOUT_MS: "60000"
    networks: [celestia_boundary, control]

  topology-probe:
    <<: *harness-service
    depends_on:
      postgres: { condition: service_healthy }
      midnight-node: { condition: service_healthy }
      midnight-indexer: { condition: service_healthy }
      proof-server: { condition: service_started }
      app-toolchain-check: { condition: service_completed_successfully }
      celestia-proxy: { condition: service_healthy }
    environment:
      HARNESS_ROLE: dependency-probe
      HARNESS_DEPENDENCY_TIMEOUT_MS: "240000"
      HARNESS_DEPENDENCY_PROBES: ${dependencyProbes}
    networks: [offerfiles_private, midnight_private, celestia_boundary, control]

  solver-isolation-probe:
    <<: *harness-service
    depends_on:
      celestia: { condition: service_healthy }
      celestia-proxy: { condition: service_healthy }
    environment:
      HARNESS_ROLE: isolation-probe
      HARNESS_FORBIDDEN_ENV_PREFIXES: '["CELESTIA"]'
      HARNESS_FORBIDDEN_TCP_TARGETS: '[{"host":"celestia","port":26658},{"host":"celestia-proxy","port":8080}]'
    networks: [solver_front]

networks:
  solver_front: { internal: true }
  offerfiles_private: { internal: true }
  midnight_private: { internal: true }
  celestia_boundary: { internal: true }
  build_private: { internal: true }
  control: { internal: true }
  host_access: {}
  proof_egress: {}
`;
}

export interface RealE1AcceptanceComposeInput extends RealE1ComposeInput {
  runtimeDirectory: string;
}

/**
 * Full real-service acceptance topology. Unlike `realE1ComposeSource`, this
 * includes the production backend and production solver entry boundary. It is
 * still generated only inside the mode-0700 per-run directory.
 */
export function realE1AcceptanceComposeSource(input: RealE1AcceptanceComposeInput): string {
  const source = quoteYaml(input.serviceSource);
  const traffic = quoteYaml(input.trafficPath);
  const deploymentRuntime = quoteYaml(`${input.runtimeDirectory}/deployment`);
  const actorRuntime = quoteYaml(`${input.runtimeDirectory}/actor`);
  const publicationRuntime = quoteYaml(`${input.runtimeDirectory}/publication`);
  const invalidRuntime = quoteYaml(`${input.runtimeDirectory}/invalid`);
  const solverRuntime = quoteYaml(
    "${E1_ACTIVE_SOLVER_OUTPUT_DIRECTORY:?E1_ACTIVE_SOLVER_OUTPUT_DIRECTORY must be set}",
  );
  const garbagePublicationRuntime = quoteYaml(
    "${E1_ACTIVE_GARBAGE_OUTPUT_DIRECTORY:?E1_ACTIVE_GARBAGE_OUTPUT_DIRECTORY must be set}",
  );
  const walletSettlementRuntime = quoteYaml(`${input.runtimeDirectory}/wallet-settlement`);
  const backendSettlementRuntime = quoteYaml(`${input.runtimeDirectory}/backend-settlement`);
  const controlRuntime = quoteYaml(`${input.runtimeDirectory}/control`);
  const harnessHealthcheck = quoteYaml(
    "fetch('http://127.0.0.1:8080/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
  );
  const backendHealthcheck = quoteYaml(
    "fetch('http://127.0.0.1:9999/v1/health/sync').then(async r=>{const v=await r.json();if(!r.ok||v.status!=='ok'||!v.blockL2||v.midnight?.current==null||v.midnight?.tip==null||v.celestia?.current==null||v.celestia?.tip==null)process.exit(1)}).catch(()=>process.exit(1))",
  );
  const nodeGatewayHealth = quoteYaml(
    "const s=require('node:net').connect(9944,'127.0.0.1');const t=setTimeout(()=>process.exit(1),1500);s.on('connect',()=>{clearTimeout(t);s.end();process.exit(0)});s.on('error',()=>process.exit(1))",
  );
  const indexerGatewayHealth = quoteYaml(
    "const s=require('node:net').connect(8088,'127.0.0.1');const t=setTimeout(()=>process.exit(1),1500);s.on('connect',()=>{clearTimeout(t);s.end();process.exit(0)});s.on('error',()=>process.exit(1))",
  );
  const proofGatewayHealth = quoteYaml(
    "const s=require('node:net').connect(6300,'127.0.0.1');const t=setTimeout(()=>process.exit(1),1500);s.on('connect',()=>{clearTimeout(t);s.end();process.exit(0)});s.on('error',()=>process.exit(1))",
  );
  const celestiaForwarderHealth = quoteYaml(
    "const s=require('node:net').connect(26659,'127.0.0.1');const t=setTimeout(()=>process.exit(1),1500);s.on('connect',()=>{clearTimeout(t);s.end();process.exit(0)});s.on('error',()=>process.exit(1))",
  );
  const copyContract = [
    "test \"$(stat -c '%a' /inputs/deployment/contract-offer-files.undeployed.json)\" = 600",
    "test \"$(stat -c '%a' /inputs/deployment/contract-offer-files.undeployed.sha256)\" = 600",
    "(cd /inputs/deployment && sha256sum -c contract-offer-files.undeployed.sha256)",
    "install -m 0600 /inputs/deployment/contract-offer-files.undeployed.json packages/contracts-midnight/contract-offer-files.undeployed.json",
  ].join(" && ");
  const backendCommand = quoteYaml(`${copyContract} && exec bun run packages/node/main.dev.ts`);
  const midnightEnvironment = `
      MIDNIGHT_NETWORK_ID: undeployed
      MIDNIGHT_INDEXER_HTTP: http://midnight-indexer-gateway:8088/api/v3/graphql
      MIDNIGHT_INDEXER_WS: ws://midnight-indexer-gateway:8088/api/v3/graphql/ws
      MIDNIGHT_NODE_HTTP: http://midnight-node-gateway:9944
      MIDNIGHT_PROOF_SERVER_URL: http://midnight-proof-gateway:6300
      MIDNIGHT_STORAGE_PASSWORD: "\${MIDNIGHT_STORAGE_PASSWORD:?MIDNIGHT_STORAGE_PASSWORD must be set}"`;

  return `x-complete-logging:
  ${COMPLETE_LOGGING.replaceAll("\n", "\n  ")}

x-proof-logging:
  ${PROOF_LOGGING.replaceAll("\n", "\n  ")}

x-harness-service: &harness-service
  image: ${REAL_E1_PINS.nodeImage}
  pull_policy: missing
  command: ["node", "/opt/harness/service.mjs"]
  restart: "no"
  init: true
  ${USE_COMPLETE_LOGGING}
  volumes:
    - type: bind
      source: ${source}
      target: /opt/harness/service.mjs
      read_only: true
  healthcheck:
    test: ["CMD", "node", "-e", ${harnessHealthcheck}]
    interval: 2s
    timeout: 2s
    retries: 120
    start_period: 2s

x-app-service: &app-service
  image: ${input.appImage}
  pull_policy: never
  platform: linux/arm64
  working_dir: /work
  restart: "no"
  init: true
  ${USE_COMPLETE_LOGGING}

services:
  traffic-recorder:
    <<: *harness-service
    environment:
      HARNESS_ROLE: collector
      HARNESS_CHANNEL: recorder
      HARNESS_TRAFFIC_PATH: /opt/harness/traffic.jsonl
    volumes:
      - type: bind
        source: ${source}
        target: /opt/harness/service.mjs
        read_only: true
      - type: bind
        source: ${traffic}
        target: /opt/harness/traffic.jsonl
    ports:
      - "127.0.0.1:\${RECORDER_HOST_PORT:?RECORDER_HOST_PORT must be set}:8080"
    networks: [control, host_access]

  ntp-responder:
    <<: *harness-service
    depends_on:
      traffic-recorder: { condition: service_healthy }
    read_only: true
    cap_drop: [ALL]
    cap_add: [NET_BIND_SERVICE]
    security_opt: ["no-new-privileges:true"]
    environment:
      HARNESS_ROLE: ntp-responder
      HARNESS_CHANNEL: backend-ntp
      HARNESS_COLLECTOR_URL: http://traffic-recorder:8080
      HARNESS_UPSTREAM_TIMEOUT_MS: "1000"
      HARNESS_NTP_BIND_HOST: e1-ntp-boundary
      HARNESS_NTP_PORT: "123"
      HARNESS_NTP_TIMESTAMP_WINDOW_MS: "30000"
      HARNESS_NTP_MAX_CONCURRENCY: "16"
      HARNESS_NTP_RATE_PER_SECOND: "32"
      HARNESS_NTP_RATE_BURST: "32"
      HARNESS_NTP_MAX_RESPONSES: "4096"
    networks:
      backend_ntp:
        aliases:
          - e1-ntp-boundary
          - 0.pool.ntp.org
          - 1.pool.ntp.org
          - 2.pool.ntp.org
          - 3.pool.ntp.org
      control: {}

  postgres:
    image: ${REAL_E1_PINS.postgres}
    pull_policy: missing
    platform: linux/arm64
    restart: "no"
    ${USE_COMPLETE_LOGGING}
    environment:
      POSTGRES_USER: postgres
      POSTGRES_DB: postgres
      POSTGRES_PASSWORD: "\${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d postgres"]
      interval: 2s
      timeout: 3s
      retries: 90
      start_period: 2s
    tmpfs:
      - /var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=536870912,uid=70,gid=70,mode=0700
      - /var/run/postgresql:rw,nosuid,nodev,noexec,size=16777216,uid=70,gid=70,mode=3777
    networks: [offerfiles_private]

  midnight-node:
    image: ${REAL_E1_PINS.midnightNode}
    pull_policy: missing
    platform: linux/arm64
    restart: "no"
    ${USE_COMPLETE_LOGGING}
    cap_drop: [ALL]
    cap_add: [CHOWN, DAC_OVERRIDE, FOWNER]
    security_opt: ["no-new-privileges:true"]
    environment:
      CFG_PRESET: dev
      SIDECHAIN_BLOCK_BENEFICIARY: "04bcf7ad3be7a5c790460be82a713af570f22e0f801f6659ab8e84a52be6969e"
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          curl -fs -H 'Content-Type: application/json'
          -d '{"id":1,"jsonrpc":"2.0","method":"chain_getBlockHash","params":[1]}'
          http://127.0.0.1:9944 | grep -q '"result":"0x'
      interval: 2s
      timeout: 5s
      retries: 90
      start_period: 5s
    tmpfs:
      - /node/chain:rw,nosuid,nodev,noexec,size=1073741824,uid=0,gid=0,mode=0700
    networks: [midnight_private]

  midnight-indexer:
    image: ${REAL_E1_PINS.midnightIndexer}
    pull_policy: missing
    platform: linux/arm64
    restart: "no"
    ${USE_COMPLETE_LOGGING}
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    depends_on:
      midnight-node: { condition: service_healthy }
    environment:
      RUST_LOG: "indexer=info,chain_indexer=info,indexer_api=info,wallet_indexer=info,indexer_common=info,fastrace_opentelemetry=off,info"
      APP__APPLICATION__NETWORK_ID: undeployed
      APP__INFRA__NODE__URL: ws://midnight-node:9944
      APP__INFRA__STORAGE__PASSWORD: indexer
      APP__INFRA__PUB_SUB__PASSWORD: indexer
      APP__INFRA__LEDGER_STATE_STORAGE__PASSWORD: indexer
      APP__INFRA__SECRET: "\${MIDNIGHT_INDEXER_SECRET:?MIDNIGHT_INDEXER_SECRET must be set}"
      APP__INFRA__SPO_NODE__URL: ws://midnight-node:9944
      APP__INFRA__SPO_NODE__BLOCKFROST_ID: e1-test-dummy-id
    healthcheck:
      test: ["CMD-SHELL", "cat /var/run/indexer-standalone/running"]
      interval: 5s
      timeout: 5s
      retries: 48
      start_period: 60s
    tmpfs:
      - /data:rw,nosuid,nodev,noexec,size=536870912,uid=10001,gid=10001,mode=0700
      - /var/run/indexer-standalone:rw,nosuid,nodev,noexec,size=16777216,uid=10001,gid=10001,mode=0700
    networks: [midnight_private]

  proof-server:
    image: ${REAL_E1_PINS.midnightProof}
    pull_policy: missing
    platform: linux/arm64
    restart: "no"
    ${USE_PROOF_LOGGING}
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    command: [${quoteYaml(REAL_E1_PROOF_COMPOSE_COMMAND)}]
    environment:
      E1_PROOF_LOG_MARKER: ${quoteYaml(input.proofLogMarker)}
      RUST_LOG: info
      RUST_BACKTRACE: "0"
      MIDNIGHT_PROOF_SERVER_VERBOSE: "false"
    tmpfs:
      - /.cache/midnight/zk-params:rw,nosuid,nodev,noexec,size=1073741824,uid=0,gid=0,mode=0700
    networks: [midnight_private, proof_egress]

  midnight-node-gateway:
    <<: *harness-service
    depends_on:
      midnight-node: { condition: service_healthy }
    environment:
      HARNESS_ROLE: tcp-forwarder
      HARNESS_PORT: "9944"
      HARNESS_TCP_TARGET_HOST: midnight-node
      HARNESS_TCP_TARGET_PORT: "9944"
    healthcheck:
      test: ["CMD", "node", "-e", ${nodeGatewayHealth}]
      interval: 2s
      timeout: 2s
      retries: 60
      start_period: 1s
    networks: [midnight_private, midnight_contract_clients, midnight_backend_clients, midnight_actor_clients, midnight_solver_clients]

  midnight-indexer-gateway:
    <<: *harness-service
    depends_on:
      midnight-indexer: { condition: service_healthy }
    environment:
      HARNESS_ROLE: tcp-forwarder
      HARNESS_PORT: "8088"
      HARNESS_TCP_TARGET_HOST: midnight-indexer
      HARNESS_TCP_TARGET_PORT: "8088"
    healthcheck:
      test: ["CMD", "node", "-e", ${indexerGatewayHealth}]
      interval: 2s
      timeout: 2s
      retries: 60
      start_period: 1s
    networks: [midnight_private, midnight_contract_clients, midnight_backend_clients, midnight_actor_clients, midnight_solver_clients]

  midnight-proof-gateway:
    <<: *harness-service
    depends_on:
      proof-server: { condition: service_started }
    environment:
      HARNESS_ROLE: tcp-forwarder
      HARNESS_PORT: "6300"
      HARNESS_TCP_TARGET_HOST: proof-server
      HARNESS_TCP_TARGET_PORT: "6300"
    healthcheck:
      test: ["CMD", "node", "-e", ${proofGatewayHealth}]
      interval: 2s
      timeout: 2s
      retries: 180
      start_period: 2s
    networks: [midnight_private, midnight_contract_clients, midnight_backend_clients, midnight_actor_clients, midnight_solver_clients]

  contract-deployer:
    <<: *app-service
    depends_on:
      midnight-node-gateway: { condition: service_healthy }
      midnight-indexer-gateway: { condition: service_healthy }
      midnight-proof-gateway: { condition: service_healthy }
    command:
      - bash
      - -c
      - >-
        cd packages/contracts-midnight &&
        bun run midnight-contract:deploy &&
        install -m 0600 contract-offer-files.undeployed.json
        /outputs/deployment/contract-offer-files.undeployed.json &&
        cd /outputs/deployment &&
        sha256sum contract-offer-files.undeployed.json > contract-offer-files.undeployed.sha256 &&
        chmod 0600 contract-offer-files.undeployed.sha256
    environment:${midnightEnvironment}
    volumes:
      - type: bind
        source: ${deploymentRuntime}
        target: /outputs/deployment
    networks: [midnight_contract_clients]

  celestia:
    image: ${input.celestiaImage}
    pull_policy: never
    platform: linux/amd64
    restart: "no"
    init: true
    ${USE_COMPLETE_LOGGING}
    tmpfs:
      - /tmp:rw,nosuid,nodev,size=1073741824,uid=0,gid=0,mode=1777
    networks: [celestia_boundary]

  celestia-forwarder:
    <<: *harness-service
    network_mode: service:celestia
    depends_on:
      celestia: { condition: service_healthy }
    environment:
      HARNESS_ROLE: tcp-forwarder
      HARNESS_PORT: "26659"
      HARNESS_TCP_TARGET_HOST: 127.0.0.1
      HARNESS_TCP_TARGET_PORT: "26658"
    healthcheck:
      test: ["CMD", "node", "-e", ${celestiaForwarderHealth}]
      interval: 2s
      timeout: 2s
      retries: 60
      start_period: 1s

  backend-celestia-proxy:
    <<: *harness-service
    depends_on:
      traffic-recorder: { condition: service_healthy }
      celestia-forwarder: { condition: service_healthy }
    environment:
      HARNESS_ROLE: proxy
      HARNESS_CHANNEL: backend-celestia
      HARNESS_COLLECTOR_URL: http://traffic-recorder:8080
      HARNESS_UPSTREAM_URL: http://celestia:26659
      HARNESS_UPSTREAM_TIMEOUT_MS: "60000"
    networks: [celestia_boundary, backend_egress, control]

  publisher-celestia-proxy:
    <<: *harness-service
    depends_on:
      traffic-recorder: { condition: service_healthy }
      celestia-forwarder: { condition: service_healthy }
    environment:
      HARNESS_ROLE: proxy
      HARNESS_CHANNEL: publisher-celestia
      HARNESS_COLLECTOR_URL: http://traffic-recorder:8080
      HARNESS_UPSTREAM_URL: http://celestia:26659
      HARNESS_UPSTREAM_TIMEOUT_MS: "60000"
    networks: [celestia_boundary, publisher_egress, control]

  batcher-sink:
    <<: *harness-service
    depends_on:
      traffic-recorder: { condition: service_healthy }
    environment:
      HARNESS_ROLE: proxy
      HARNESS_CHANNEL: batcher
      HARNESS_COLLECTOR_URL: http://traffic-recorder:8080
    networks: [backend_egress, control]

  offerfiles-backend:
    <<: *app-service
    depends_on:
      postgres: { condition: service_healthy }
      ntp-responder: { condition: service_healthy }
      contract-deployer: { condition: service_completed_successfully }
      backend-celestia-proxy: { condition: service_healthy }
      batcher-sink: { condition: service_healthy }
      midnight-node-gateway: { condition: service_healthy }
      midnight-indexer-gateway: { condition: service_healthy }
      midnight-proof-gateway: { condition: service_healthy }
    command: ["bash", "-c", ${backendCommand}]
    environment:${midnightEnvironment}
      PGLITE: "false"
      DB_HOST: postgres
      DB_PORT: "5432"
      DB_NAME: postgres
      DB_USER: postgres
      DB_PW: "\${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}"
      ALLOW_NO_PG_IVM: "true"
      CELESTIA_RPC_URL: http://backend-celestia-proxy:8080
      CELESTIA_NETWORK: devnet
      CELESTIA_POLLING_INTERVAL_MS: "1000"
      EFFECTSTREAM_API_PORT: "9999"
      ENABLE_DEV_AND_DEBUG_ENDPOINTS: "true"
      API_RATE_LIMIT_MAX: "10000"
      ROOT_WINDOW_SECONDS: "28800"
      OFFER_TTL_SECONDS: "28800"
      OFFER_VALIDATION_TIMEOUT_MS: "30000"
      SOLVER_LEVELS_AUTH_KEYS: "\${SOLVER_AUTH_REGISTRY:?SOLVER_AUTH_REGISTRY must be set}"
      BATCHER_SUBMIT_URL: http://batcher-sink:8080
    healthcheck:
      test: ["CMD", "bun", "-e", ${backendHealthcheck}]
      interval: 3s
      timeout: 8s
      retries: 180
      start_period: 20s
    volumes:
      - type: bind
        source: ${deploymentRuntime}
        target: /inputs/deployment
        read_only: true
    networks: [offerfiles_private, backend_egress, midnight_backend_clients, backend_ntp]

  backend-proxy:
    <<: *harness-service
    depends_on:
      traffic-recorder: { condition: service_healthy }
      offerfiles-backend: { condition: service_healthy }
    environment:
      HARNESS_ROLE: proxy
      HARNESS_CHANNEL: backend
      HARNESS_COLLECTOR_URL: http://traffic-recorder:8080
      HARNESS_UPSTREAM_URL: http://offerfiles-backend:9999
      HARNESS_UPSTREAM_TIMEOUT_MS: "60000"
    networks: [offerfiles_private, solver_front, control]

  telemetry-relay:
    <<: *harness-service
    depends_on:
      traffic-recorder: { condition: service_healthy }
    environment:
      HARNESS_ROLE: telemetry
      HARNESS_CHANNEL: solver-validation
      HARNESS_COLLECTOR_URL: http://traffic-recorder:8080
      HARNESS_TELEMETRY_IDENTITIES: "\${TELEMETRY_IDENTITIES:?TELEMETRY_IDENTITIES must be set}"
    volumes:
      - type: bind
        source: ${source}
        target: /opt/harness/service.mjs
        read_only: true
      - type: bind
        source: ${controlRuntime}
        target: /run/e1-control
        read_only: true
      - type: bind
        source: ${actorRuntime}
        target: /inputs/actor
        read_only: true
    networks: [solver_front, control]

  actor-provisioner:
    <<: *app-service
    profiles: [acceptance-manual]
    depends_on:
      contract-deployer: { condition: service_completed_successfully }
      midnight-node-gateway: { condition: service_healthy }
      midnight-indexer-gateway: { condition: service_healthy }
      midnight-proof-gateway: { condition: service_healthy }
    command:
      - bash
      - -c
      - >-
        ${copyContract} &&
        exec bun packages/tests/grand-e2e/lib/solver-offerfiles-real-actors.ts provision
    environment:${midnightEnvironment}
      E1_RUN_ID: "\${E1_ACCEPTANCE_RUN_ID:?E1_ACCEPTANCE_RUN_ID must be set}"
      E1_GENESIS_SEED: "\${E1_GENESIS_SEED:?E1_GENESIS_SEED must be set}"
      E1_USER_SEED: "\${E1_USER_SEED:?E1_USER_SEED must be set}"
      E1_SOLVER_SEED: "\${E1_SOLVER_SEED:?E1_SOLVER_SEED must be set}"
      E1_ACTOR_RESULT_PATH: /outputs/actor/actor-manifest.json
      E1_ACTOR_RUNTIME_PATH: /outputs/actor/actor-runtime.json
      E1_ACTOR_LADDER_PATH: /outputs/actor/solver-ladder.json
      E1_ACTOR_PRE_SPENT_PATH: /outputs/actor/pre-spent-liveness.json
      E1_OFFER_TTL_MS: "28800000"
      E1_SYNC_TIMEOUT_MS: "300000"
      E1_FUNDING_TIMEOUT_MS: "300000"
    volumes:
      - type: bind
        source: ${deploymentRuntime}
        target: /inputs/deployment
        read_only: true
      - type: bind
        source: ${actorRuntime}
        target: /outputs/actor
    networks: [midnight_actor_clients]

  offer-publisher:
    <<: *app-service
    profiles: [acceptance-manual]
    command:
      - bun
      - packages/tests/grand-e2e/lib/solver-offerfiles-real-publisher.ts
      - publish-offer
    environment:
      E1_RUN_ID: "\${E1_ACCEPTANCE_RUN_ID:?E1_ACCEPTANCE_RUN_ID must be set}"
      E1_ACTOR_RESULT_PATH: /inputs/actor/actor-manifest.json
      E1_PUBLISHER_EVIDENCE_PATH: /outputs/publication/offer-publication.json
      E1_CELESTIA_RPC_URL: http://publisher-celestia-proxy:8080
      E1_EXPECTED_NETWORK_ID: undeployed
      E1_PUBLISHER_DEADLINE_MS: "120000"
    volumes:
      - type: bind
        source: ${actorRuntime}
        target: /inputs/actor
        read_only: true
      - type: bind
        source: ${publicationRuntime}
        target: /outputs/publication
    networks: [publisher_egress]

  invalid-fixture-generator:
    <<: *app-service
    profiles: [acceptance-manual]
    command:
      - bun
      - packages/tests/grand-e2e/lib/solver-offerfiles-real-invalid-fixtures.ts
      - build
    environment:
      MIDNIGHT_NETWORK_ID: undeployed
      E1_RUN_ID: "\${E1_ACCEPTANCE_RUN_ID:?E1_ACCEPTANCE_RUN_ID must be set}"
      E1_ACTOR_RESULT_PATH: /inputs/actor/actor-manifest.json
      E1_PRE_SPENT_PATH: /inputs/actor/pre-spent-liveness.json
      E1_INVALID_FIXTURE_PATH: /outputs/invalid/invalid-fixtures.json
    volumes:
      - type: bind
        source: ${actorRuntime}
        target: /inputs/actor
        read_only: true
      - type: bind
        source: ${invalidRuntime}
        target: /outputs/invalid
    network_mode: none

  garbage-publisher:
    <<: *app-service
    profiles: [acceptance-manual]
    command:
      - bun
      - packages/tests/grand-e2e/lib/solver-offerfiles-real-publisher.ts
      - publish-garbage
    environment:
      E1_RUN_ID: "\${E1_ACCEPTANCE_RUN_ID:?E1_ACCEPTANCE_RUN_ID must be set}"
      E1_ACTOR_RESULT_PATH: /inputs/actor/actor-manifest.json
      E1_PUBLISHER_EVIDENCE_PATH: /outputs/publication/garbage-publication.json
      E1_CELESTIA_RPC_URL: http://publisher-celestia-proxy:8080
      E1_EXPECTED_NETWORK_ID: undeployed
      E1_PUBLISHER_DEADLINE_MS: "120000"
      E1_PUBLISHER_GARBAGE_MAX_BYTES: "1048576"
      E1_PUBLISHER_GARBAGE_LABEL: "\${E1_ACTIVE_GARBAGE_LABEL:?E1_ACTIVE_GARBAGE_LABEL must be set}"
      E1_PUBLISHER_RAW_BLOB_BASE64: "\${E1_ACTIVE_GARBAGE_BLOB_BASE64:?E1_ACTIVE_GARBAGE_BLOB_BASE64 must be set}"
    volumes:
      - type: bind
        source: ${actorRuntime}
        target: /inputs/actor
        read_only: true
      - type: bind
        source: ${garbagePublicationRuntime}
        target: /outputs/publication
    networks: [publisher_egress]

  solver-case:
    <<: *app-service
    profiles: [acceptance-manual]
    command:
      - bash
      - -c
      - >-
        ${copyContract} &&
        exec bun packages/tests/grand-e2e/lib/solver-offerfiles-real-solver-service.ts run
    environment:${midnightEnvironment}
      E1_RUN_ID: "\${E1_ACTIVE_RUN_ID:?E1_ACTIVE_RUN_ID must be set}"
      E1_SOLVER_SEED: "\${E1_SOLVER_SEED:?E1_SOLVER_SEED must be set}"
      E1_SOLVER_API: http://backend-proxy:8080
      E1_SOLVER_AUTH_TOKEN: "\${E1_ACTIVE_SOLVER_TOKEN:?E1_ACTIVE_SOLVER_TOKEN must be set}"
      E1_SOLVER_LADDER_CONFIG: /inputs/actor/solver-ladder.json
      E1_SOLVER_TELEMETRY_PATH: /outputs/solver/solver-telemetry.jsonl
      E1_SOLVER_RUNTIME_PATH: /outputs/solver/solver-runtime.json
      E1_SOLVER_RECORDER_URL: http://telemetry-relay:8080/record
      E1_SOLVER_RECORDER_TOKEN: "\${E1_ACTIVE_RECORDER_TOKEN:?E1_ACTIVE_RECORDER_TOKEN must be set}"
      E1_SOLVER_RECORDER_TIMEOUT_MS: "15000"
      E1_SOLVER_STARTUP_TIMEOUT_MS: "300000"
      E1_SOLVER_WALLET_OPERATION_TIMEOUT_MS: "300000"
      E1_SOLVER_STOP_TIMEOUT_MS: "60000"
      OFFER_TTL_SECONDS: "3600"
      SOLVER_EXPIRY_MARGIN_SECONDS: "30"
      SOLVER_RESYNC_INTERVAL_MS: "2000"
      SOLVER_BACKEND_HEALTH_CHECK_INTERVAL_MS: "500"
      SOLVER_BACKEND_HEALTH_MAX_AGE_MS: "5000"
      SOLVER_STATUS_POLL_MS: "500"
      SOLVER_ENABLE_PATH_B: "false"
      SOLVER_ENABLE_CYCLES: "false"
      SOLVER_ENABLE_RESIDUAL_TOPUPS: "false"
      SOLVER_DRY_RUN: "false"
    volumes:
      - type: bind
        source: ${deploymentRuntime}
        target: /inputs/deployment
        read_only: true
      - type: bind
        source: ${actorRuntime}
        target: /inputs/actor
        read_only: true
      - type: bind
        source: ${solverRuntime}
        target: /outputs/solver
    networks: [solver_front, midnight_solver_clients]

  settlement-verifier:
    <<: *app-service
    profiles: [acceptance-manual]
    command:
      - bash
      - -c
      - >-
        ${copyContract} &&
        exec bun packages/tests/grand-e2e/lib/solver-offerfiles-real-actors.ts verify-settlement
    environment:${midnightEnvironment}
      E1_RUN_ID: "\${E1_ACCEPTANCE_RUN_ID:?E1_ACCEPTANCE_RUN_ID must be set}"
      E1_USER_SEED: "\${E1_USER_SEED:?E1_USER_SEED must be set}"
      E1_SOLVER_SEED: "\${E1_SOLVER_SEED:?E1_SOLVER_SEED must be set}"
      E1_ACTOR_RESULT_PATH: /inputs/actor/actor-manifest.json
      E1_ACTOR_RUNTIME_PATH: /outputs/settlement/settlement-runtime.json
      E1_ACTOR_SETTLEMENT_PATH: /outputs/settlement/settlement-evidence.json
      E1_SYNC_TIMEOUT_MS: "300000"
      E1_SETTLEMENT_TIMEOUT_MS: "300000"
    volumes:
      - type: bind
        source: ${deploymentRuntime}
        target: /inputs/deployment
        read_only: true
      - type: bind
        source: ${actorRuntime}
        target: /inputs/actor
        read_only: true
      - type: bind
        source: ${walletSettlementRuntime}
        target: /outputs/settlement
    networks: [midnight_actor_clients]

  backend-settlement-verifier:
    <<: *app-service
    profiles: [acceptance-manual]
    command:
      - bun
      - packages/tests/grand-e2e/lib/solver-offerfiles-real-settlement-verifier.ts
      - verify
    environment:
      E1_RUN_ID: "\${E1_ACCEPTANCE_RUN_ID:?E1_ACCEPTANCE_RUN_ID must be set}"
      E1_ACTOR_RESULT_PATH: /inputs/actor/actor-manifest.json
      E1_SOLVER_RUNTIME_PATH: /inputs/solver/solver-runtime.json
      E1_PUBLISHER_EVIDENCE_PATH: /inputs/publication/offer-publication.json
      E1_SETTLEMENT_EVIDENCE_PATH: /outputs/settlement/backend-settlement-evidence.json
      E1_SETTLEMENT_BACKEND_URL: http://backend-proxy:8080
      E1_SETTLEMENT_DEADLINE_MS: "300000"
      DB_HOST: postgres
      DB_PORT: "5432"
      DB_NAME: postgres
      DB_USER: postgres
      DB_PW: "\${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}"
    volumes:
      - type: bind
        source: ${actorRuntime}
        target: /inputs/actor
        read_only: true
      - type: bind
        source: ${publicationRuntime}
        target: /inputs/publication
        read_only: true
      - type: bind
        source: ${solverRuntime}
        target: /inputs/solver
        read_only: true
      - type: bind
        source: ${backendSettlementRuntime}
        target: /outputs/settlement
    networks: [offerfiles_private]

  solver-isolation-probe:
    <<: *harness-service
    depends_on:
      celestia: { condition: service_healthy }
      backend-proxy: { condition: service_healthy }
      telemetry-relay: { condition: service_healthy }
    environment:
      HARNESS_ROLE: isolation-probe
      HARNESS_FORBIDDEN_ENV_PREFIXES: '["CELESTIA","BATCHER"]'
      HARNESS_FORBIDDEN_TCP_TARGETS: '[{"host":"celestia","port":26658},{"host":"backend-celestia-proxy","port":8080},{"host":"publisher-celestia-proxy","port":8080},{"host":"batcher-sink","port":8080},{"host":"postgres","port":5432},{"host":"offerfiles-backend","port":9999}]'
    networks: [solver_front]

networks:
  solver_front: { internal: true }
  offerfiles_private: { internal: true }
  backend_egress: { internal: true }
  backend_ntp: { internal: true }
  publisher_egress: { internal: true }
  midnight_private: { internal: true }
  midnight_contract_clients: { internal: true }
  midnight_backend_clients: { internal: true }
  midnight_actor_clients: { internal: true }
  midnight_solver_clients: { internal: true }
  celestia_boundary: { internal: true }
  control: { internal: true }
  host_access: {}
  proof_egress: {}
`;
}
