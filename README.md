# uvlink

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
```

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
