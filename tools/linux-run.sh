#!/usr/bin/env bash
set -euo pipefail
LOCALAI_FORK_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export LOCALAI_FORK_ROOT
cd "$LOCALAI_FORK_ROOT"

if [[ "${1:-}" == "--check" ]]; then
  command -v node
  command -v npm
  command -v flock
  command -v make || true
  command -v g++ || true
  node --version
  printf '%s\n' 'This launcher uses Node 24, Yarn Classic, ports 3002/8889, and this checkout’s server/storage.'
  exit 0
fi
if [[ "${EUID}" -eq 0 ]]; then
  printf '%s\n' 'Run this launcher as your normal user, without sudo.' >&2
  exit 1
fi
command -v node >/dev/null || { printf '%s\n' 'Install Node.js and npm first (CachyOS packages: nodejs and npm).' >&2; exit 1; }
command -v npm >/dev/null || { printf '%s\n' 'Install npm first.' >&2; exit 1; }
# Match the upstream build's Node major without recursively relaunching through
# npm exec. npm exec can put project binaries ahead of the requested tools.
# An explicit, checkout-local toolchain makes selection deterministic.
if [[ "$(node -p 'process.versions.node.split(".")[0]')" != "24" ]] || ! command -v yarn >/dev/null || [[ "$(yarn --version)" != 1.* ]]; then
  FORK_TOOLCHAIN="$LOCALAI_FORK_ROOT/server/storage/.fork-toolchain"
  mkdir -p "$FORK_TOOLCHAIN"
  if [[ ! -x "$FORK_TOOLCHAIN/node_modules/node/bin/node" ]] || [[ ! -f "$FORK_TOOLCHAIN/node_modules/yarn/bin/yarn.js" ]]; then
    printf '%s\n' 'Installing checkout-local Node 24 and Yarn Classic (one-time setup)…'
    npm install --prefix "$FORK_TOOLCHAIN" --no-save --package-lock=false node@24 yarn@1.22.22
  fi
  export PATH="$FORK_TOOLCHAIN/node_modules/node/bin:$FORK_TOOLCHAIN/node_modules/yarn/bin:$PATH"
fi
if [[ "$(node -p 'process.versions.node.split(".")[0]')" != "24" ]] || ! command -v yarn >/dev/null || [[ "$(yarn --version)" != 1.* ]]; then
  printf '%s\n' 'Could not select Node 24 and Yarn Classic. Setup stopped; no automatic relaunch.' >&2
  exit 1
fi
if [[ "${1:-}" == "--check-toolchain" ]]; then
  node --version
  yarn --version
  exit 0
fi
command -v flock >/dev/null || { printf '%s\n' 'flock is required (util-linux on CachyOS).' >&2; exit 1; }
mkdir -p server/storage
exec 9>server/storage/.fork-run.lock
flock -n 9 || { printf '%s\n' 'This checkout is already running or building.' >&2; exit 1; }
export NODE_ENV=production
export STORAGE_DIR="$LOCALAI_FORK_ROOT/server/storage"
export SERVER_PORT=3002 COLLECTOR_PORT=8889 SERVER_HOST=127.0.0.1 COLLECTOR_HOST=127.0.0.1
export DISABLE_TELEMETRY=true CHECKPOINT_DISABLE=1

# Fail before installing/building if either test port is occupied.
node <<'JS'
const net = require('net');
(async () => {
  for (const port of [3002, 8889]) {
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', () => reject(new Error(`Port ${port} is already in use. Stop that test instance first.`)));
      server.listen(port, '127.0.0.1', () => server.close(resolve));
    });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
JS

node <<'JS'
const fs = require('fs');
const { randomBytes } = require('crypto');
if (!fs.existsSync('server/.env')) {
  const secret = () => randomBytes(32).toString('hex');
  fs.writeFileSync('server/.env', [
    'SERVER_PORT=3002', 'COLLECTOR_PORT=8889', 'DISABLE_TELEMETRY=true',
    `JWT_SECRET=${secret()}`, `SIG_KEY=${secret()}`, `SIG_SALT=${secret()}`,
    'LLM_PROVIDER=ollama', 'OLLAMA_BASE_PATH=http://127.0.0.1:11434',
    'OLLAMA_MODEL_PREF=qwen3.5:9b', 'OLLAMA_MODEL_TOKEN_LIMIT=32768',
    'EMBEDDING_ENGINE=ollama', 'EMBEDDING_BASE_PATH=http://127.0.0.1:11434',
    'EMBEDDING_MODEL_PREF=nomic-embed-text:latest', 'EMBEDDING_MODEL_MAX_CHUNK_LENGTH=8192',
    'VECTOR_DB=lancedb', ''
  ].join('\n'), { mode: 0o600, flag: 'wx' });
}
if (!fs.existsSync('collector/.env')) fs.copyFileSync('collector/.env.example', 'collector/.env');
JS

# Install dev dependencies as well: build tooling is required for the frontend.
# Passing --production=false overrides NODE_ENV=production during installation.
FORK_BUILD_KEY="$(node <<'JS'
const fs = require('fs'), { createHash } = require('crypto'), { execFileSync } = require('child_process');
const hash = createHash('sha256');
for (const folder of ['server', 'collector', 'frontend']) {
  for (const file of ['package.json', 'yarn.lock']) hash.update(fs.readFileSync(`${folder}/${file}`));
}
try { hash.update(execFileSync('git', ['rev-parse', 'HEAD'])); }
catch { hash.update(String(Date.now())); }
hash.update(process.versions.node);
console.log(hash.digest('hex'));
JS
)"
if [[ ! -f server/storage/.fork-build.sha256 ]] || [[ "$(cat server/storage/.fork-build.sha256)" != "$FORK_BUILD_KEY" ]] || [[ ! -f server/public/index.html ]] || [[ ! -d server/node_modules ]] || [[ ! -d collector/node_modules ]]; then
  for component in server collector frontend; do
    printf 'Installing %s dependencies…\n' "$component"
    (cd "$component" && yarn install --frozen-lockfile --non-interactive --production=false)
  done
  (cd server && yarn prisma generate && yarn prisma migrate deploy)
  (cd frontend && VITE_API_BASE=/api yarn build)
  # Stage built assets, then move the previous build aside for rollback.
  node <<'JS'
const fs = require('fs');
const staging = 'server/public-fork-staging';
fs.rmSync(staging, { recursive: true, force: true });
fs.cpSync('frontend/dist', staging, { recursive: true });
if (!fs.existsSync(`${staging}/index.html`)) throw new Error('Frontend build did not produce index.html');
fs.rmSync('server/public-fork-previous', { recursive: true, force: true });
if (fs.existsSync('server/public')) fs.renameSync('server/public', 'server/public-fork-previous');
try { fs.renameSync(staging, 'server/public'); }
catch(error) {
  if (fs.existsSync('server/public-fork-previous')) fs.renameSync('server/public-fork-previous', 'server/public');
  throw error;
}
JS
  printf '%s\n' "$FORK_BUILD_KEY" >server/storage/.fork-build.sha256
fi

mkdir -p "$STORAGE_DIR/fork-logs"
server_pid=""
collector_pid=""
cleanup() {
  trap - EXIT
  [[ -z "$collector_pid" ]] || kill "$collector_pid" 2>/dev/null || true
  [[ -z "$server_pid" ]] || kill "$server_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
(cd server && exec node index.js) >"$STORAGE_DIR/fork-logs/server.log" 2>&1 &
server_pid=$!
(cd collector && exec node index.js) >"$STORAGE_DIR/fork-logs/collector.log" 2>&1 &
collector_pid=$!
ready=0
for attempt in {1..60}; do
  kill -0 "$server_pid" 2>/dev/null && kill -0 "$collector_pid" 2>/dev/null || break
  if node -e 'Promise.all([fetch("http://127.0.0.1:3002/api/ping",{signal:AbortSignal.timeout(1000)}),fetch("http://127.0.0.1:8889/accepts",{signal:AbortSignal.timeout(1000)})]).then(rs=>process.exit(rs.every(r=>r.ok)?0:1)).catch(()=>process.exit(1))'; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then
  printf '%s\n' 'Startup did not complete. Last server/collector log lines:' >&2
  tail -n 25 "$STORAGE_DIR/fork-logs/server.log" "$STORAGE_DIR/fork-logs/collector.log"
  exit 1
fi
printf '\n%s\n' 'Your fork is ready: http://127.0.0.1:3002' 'Keep this terminal open. Press Ctrl+C to stop both services.'
if command -v xdg-open >/dev/null; then xdg-open http://127.0.0.1:3002 >/dev/null 2>&1 || true; fi
wait -n "$server_pid" "$collector_pid"
