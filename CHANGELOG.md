# Changelog

All notable changes to uvlink are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [0.3.0] — Resilient tokens & legible errors

Survive token expiry, and get failures that explain themselves. Still zero
dependencies, still pure transport.

### Added
- **Reactive token refresh on 403 (HTTP).** If the endpoint rejects a request
  with 403 (e.g. the token expired out-of-band while the MicroVM was idle), uvlink
  force-refreshes the token and **replays the request once**. Only retries if the
  refresh yields a *different* token — an unchanged token means the 403 is about
  something else (e.g. the port isn't in the token's scope), so it's passed through.
  - The request body is buffered (up to 1 MiB) to enable the replay. Chunked or
    larger bodies stream through and are not retried (logged when this happens).
  - WebSocket upgrades are not auto-retried in this release.
- **`getToken.refresh()`** on the token provider — a force re-mint that bypasses
  the TTL cache and collapses concurrent calls. Static tokens expose a no-op
  `refresh()` returning the same value.
- **Typed error surfacing.** uvlink-generated errors now carry an
  `x-uvlink-error` header (`route-error`, `no-route`, `token-error`,
  `upstream-unreachable`) plus a `uvlink [kind]: detail` body, instead of a
  generic 502. Socket connect errors are translated (`ENOTFOUND` → DNS didn't
  resolve; `ECONNREFUSED`/`ETIMEDOUT`/`ECONNRESET` → endpoint unreachable, VM may
  be terminated). A pass-through 403 from the endpoint gets an `x-uvlink-hint`
  header explaining the likely token/port cause (status unchanged).

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
