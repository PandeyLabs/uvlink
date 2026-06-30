# Changelog

All notable changes to uvlink are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [0.2.0] — One MicroVM, many apps

Front several apps running on a single MicroVM through one uvlink process. Two
routing modes, both for HTTP and WebSocket, sharing one proxy core.

### Added
- **Mode A — listener-per-port** (`--map local:vm`, or `routes: [{ listen, backendPort }]`):
  each app gets its own local port. No path rewriting; every app sees itself at root.
- **Mode B — path-prefix** (`--route /prefix=vmPort`, or `routes: [{ prefix, backendPort, stripPrefix }]`):
  one local origin, a path prefix selects the app. Ideal for fronting several
  agents/services behind a single URL with no cross-origin friction.
  - Prefix is stripped before forwarding (toggle with `--no-strip-prefix` / `stripPrefix: false`).
  - `Location` response headers are rewritten to re-add the prefix so apps mounted
    under a prefix still redirect correctly.
  - Longest matching prefix wins; unmatched paths return 404.
- **Scoped tokens**: when self-minting, the token's `allowedPorts` is derived from
  the routed in-VM ports (least privilege). Override via `--allowed-ports` / `allowedPorts`
  (`all` to disable scoping).
- `examples/multi-app.mjs` (Mode A) and `examples/multi-agent.mjs` (Mode B);
  `docs/routing-spec.html` design doc.

### Changed
- Core proxy generalized to a per-request `resolveRoute(req) -> { port, path?, prefix? }`
  seam used by both the HTTP and WebSocket paths. `backendPort` / `resolvePort`
  remain supported as simpler shapes (backwards compatible).
- `createProxy().listen()` now returns `{ url, port, host, urls[] }` — `urls[]` lists
  every bound listener; the top-level fields keep the previous single-listener shape.
- **`createPool` now composes the shared proxy core** instead of duplicating the
  HTTP+WebSocket forwarding logic, fixing prior drift (it lacked the core's error
  logging and test seams) and gaining a regression test.

## [0.1.0] — Initial release

- Auth-injecting reverse proxy for a single MicroVM app: `X-aws-proxy-auth` +
  `X-aws-proxy-port` for HTTP, `lambda-microvms.*` subprotocols for WebSocket.
- Token supply three ways: static `token`, custom `getToken`, or self-mint via the
  aws CLI (`microvmId` + `region`), with automatic refresh before the 60-min TTL.
- CLI (`uvlink`) and library (`createProxy`); zero runtime dependencies.
