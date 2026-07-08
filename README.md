# uvlink

[![npm](https://img.shields.io/npm/v/uvlink.svg)](https://www.npmjs.com/package/uvlink)
[![CI](https://github.com/PandeyLabs/uvlink/actions/workflows/ci.yml/badge.svg)](https://github.com/PandeyLabs/uvlink/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/uvlink.svg)](LICENSE)
[![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

**Reach an [AWS Lambda MicroVM](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html) from a browser — without hand-rolling a proxy.**

A MicroVM endpoint requires a credential a browser can't attach: HTTP needs the
`X-aws-proxy-auth` header, and WebSockets carry the token in a custom
`lambda-microvms.*` subprotocol. So every interactive app (notebooks, web IDEs,
dashboards, terminals) ends up writing the same little auth-injecting proxy.

`uvlink` is that proxy, done once, properly:

- ✅ Injects the auth token for **HTTP** (`X-aws-proxy-auth` + `X-aws-proxy-port`)
- ✅ Injects the **WebSocket** subprotocols, preserving your app's own subprotocol
- ✅ **Auto-refreshes** the token before its 60-minute expiry (long sessions just work)
- ✅ **Zero runtime dependencies** — Node built-ins only
- ✅ Use it as a **CLI** (`npx`) or a **library**

## ⚠️ Disclaimer

**This is a personal hobby project. It is NOT an official product of, affiliated
with, supported by, or endorsed by AWS, AWS Lambda, or Amazon in any way.** It is
maintained on a best-effort, as-is basis by an individual in their personal
capacity. The names "AWS", "Lambda", and "MicroVMs" are used only descriptively to
indicate what the tool interoperates with; all trademarks belong to their
respective owners. Provided under the MIT license with no warranty (see
[`LICENSE`](LICENSE)). Use at your own risk.

## Install

```bash
npm install uvlink        # as a library
# or just run it, no install:
npx uvlink --help
```

## Quick start (CLI)

Point it at a running MicroVM; it looks up the endpoint, mints + refreshes the
token, and serves a browser-friendly local URL:

```bash
npx uvlink --microvm-id microvm-0123… --region us-east-1 --port 3000
#   ✓ open http://localhost:3000 in your browser
```

Or supply the endpoint and token yourself (no AWS calls made by the tool):

```bash
npx uvlink --endpoint xxxx.lambda-microvm.us-east-1.on.aws --token <jwe>
```

## Quick start (library)

```js
import { createProxy } from 'uvlink';

const proxy = createProxy({
  endpoint: 'xxxx.lambda-microvm.us-east-1.on.aws',
  microvmId: 'microvm-0123…',   // self-mints + refreshes the token via the aws CLI
  region: 'us-east-1',
  port: 3000,
});

const { url } = await proxy.listen();
console.log(`open ${url}`);     // browser -> http://localhost:3000
// ... later
await proxy.close();
```

## Supplying tokens — three ways

Pick whichever fits; the first two keep the library **pure transport** (no AWS dependency):

```js
// 1. static token (you manage refresh)
createProxy({ endpoint, token: '<jwe>' });

// 2. bring your own minter (SDK, your control plane, anything)
createProxy({ endpoint, getToken: async () => myMint() });

// 3. self-mint + auto-refresh via the aws CLI
createProxy({ endpoint, microvmId: 'microvm-…', region: 'us-east-1' });
```

## One MicroVM, many apps

A single MicroVM often runs several services on different in-VM ports (JupyterLab
on 8888, TensorBoard on 6006, an API on 8080; or several agents). uvlink can front
all of them from one process, two ways:

### Mode A — listener-per-port (`--map`)

Each app gets its **own local port**. Nothing rewrites paths, redirects, or
cookies, so even picky SPAs just work. The robust default.

```bash
npx uvlink --microvm-id microvm-… --region us-east-1 \
  --map 3000:8888 \   # Jupyter     -> http://localhost:3000
  --map 3001:6006 \   # TensorBoard -> http://localhost:3001
  --map 3002:8080     # API         -> http://localhost:3002
```

```js
createProxy({
  endpoint, microvmId: 'microvm-…', region: 'us-east-1',
  routes: [
    { listen: 3000, backendPort: 8888 },
    { listen: 3001, backendPort: 6006 },
  ],
});
```

### Mode B — path-prefix on one origin (`--route`)

**One** local port; a path prefix selects the app. Great for fronting several
agents/services behind a single URL with no CORS between them (a control UI can
talk to every backend same-origin). The prefix is stripped before forwarding and
`Location` redirects are rewritten so apps mounted under a prefix still work.

```bash
npx uvlink --microvm-id microvm-… --region us-east-1 --port 3000 \
  --route /agent-a=7001 \   # -> http://localhost:3000/agent-a
  --route /agent-b=7002 \   # -> http://localhost:3000/agent-b
  --route /console=7000     # -> http://localhost:3000/console
```

```js
createProxy({
  endpoint, microvmId: 'microvm-…', region: 'us-east-1', port: 3000,
  routes: [
    { prefix: '/agent-a', backendPort: 7001, stripPrefix: true },
    { prefix: '/agent-b', backendPort: 7002, stripPrefix: true },
  ],
});
```

Pass `--no-strip-prefix` (or `stripPrefix: false`) when the app is already mounted
under the prefix. Longest matching prefix wins; an unmatched path returns 404.

When self-minting, the token is automatically **scoped to just the ports you
route to** (least privilege) — pass `--allowed-ports all` (or `allowedPorts: 'all'`)
to opt out, or a custom list to override. See [`examples/multi-app.mjs`](examples/multi-app.mjs)
(Mode A), [`examples/multi-agent.mjs`](examples/multi-agent.mjs) (Mode B), and
[`docs/routing-spec.html`](docs/routing-spec.html) for the design.

## API

### `createProxy(options)`
| option | type | notes |
|---|---|---|
| `endpoint` | string | **required** — MicroVM endpoint host (no scheme) |
| `port` | number | local port (default 3000) |
| `host` | string | bind address (default `127.0.0.1`) |
| `backendPort` | string | in-VM port to route to (default `8080`) |
| `token` | string | static token, *or…* |
| `getToken` | `()=>string\|Promise<string>` | custom minter, *or…* |
| `microvmId` | string | self-mint via aws CLI (+ `region`, `awsCli`, `ttlMinutes`) |
| `onLog` | `(level,msg)=>void` | optional logger |

Returns `{ server, listen(), close() }`.

### `createPool(options)` — optional fan-out
Round-robin one browser-facing port across **multiple** MicroVM endpoints (each
with its own `getToken`). For real autoscaling/pooling/recycling, use a dedicated
load balancer; this is a convenience for simple fan-out.

```js
import { createPool } from 'uvlink';
const pool = createPool({ targets: [
  { endpoint: 'a…on.aws', getToken: () => tokA },
  { endpoint: 'b…on.aws', getToken: () => tokB },
]});
await pool.listen(3000);
```

## How it works

```
browser ──HTTP/WS──▶ uvlink ──HTTPS──▶ MicroVM endpoint
                     · HTTP:  add X-aws-proxy-auth + X-aws-proxy-port
                     · WS:    prepend lambda-microvms.* subprotocols,
                              keep the app's own subprotocol
                     · token cached + refreshed before the 60-min TTL
                     · on a 403, re-mint the token and replay the request once
```

## Resilience & errors

- **Token expiry is self-healing (HTTP).** If the endpoint returns 403 because the
  token went stale (e.g. the MicroVM was idle past the token's life), uvlink
  refreshes the token and replays the request once. Bodies up to 1 MiB are
  buffered so the replay carries the same payload; larger/chunked bodies aren't
  retried.
- **Errors say what went wrong.** uvlink-generated failures carry an
  `x-uvlink-error` header and a `uvlink [kind]: detail` body — e.g.
  `upstream-unreachable` (VM terminated or wrong endpoint), `token-error`,
  `no-route`. A pass-through 403 gets an `x-uvlink-hint` explaining the token/port
  cause.

## Examples

See [`examples/`](examples/): JupyterLab, a static site, and a WebSocket app.

## Caveats / honest scope

- This runs a local (or sidecar) proxy. It does **not** change the platform; it's
  the client-side bridge that works today. (A native browser-auth path would make
  it unnecessary — until then, this.)
- Self-minting shells out to the `aws` CLI; for SDK-based or custom auth use
  `getToken`.
- For production multi-VM serving (pooling, scaling, health, recycling) you want a
  real load balancer/autoscaler, not just `createPool`.

## Development

```bash
node test/run.mjs    # runs against a local mock endpoint — no AWS needed
```

## License

MIT
