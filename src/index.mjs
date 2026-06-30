// uvlink — a browser bridge for AWS Lambda MicroVMs.
//
// Personal hobby project. NOT affiliated with, supported by, or endorsed by
// AWS / Lambda / Amazon. MIT licensed, provided as-is, no warranty.
//
// Public API:
//   import { createProxy } from 'uvlink';
//   const proxy = createProxy({ endpoint, microvmId, region, port });
//   await proxy.listen();   // browser -> http://localhost:<port>
//
// Token supply (pick one): { token } | { getToken } | { microvmId, region }.
// The last self-mints via the aws CLI and auto-refreshes.
//
// One MicroVM, many apps. Two routing modes:
//
//   Mode A — listener-per-port: each app gets its own LOCAL port. Zero path
//   rewriting; every app sees itself at root. The robust default.
//     createProxy({ endpoint, microvmId, region, routes: [
//       { listen: 3000, backendPort: 8888 },   // Jupyter
//       { listen: 3001, backendPort: 6006 },   // TensorBoard
//     ]});
//
//   Mode B — path-prefix: ONE local origin, a path prefix picks the app. Great
//   for fronting many agents/services behind a single URL (one origin, no CORS).
//     createProxy({ endpoint, microvmId, region, port: 3000, routes: [
//       { prefix: '/agents/a', backendPort: 7001, stripPrefix: true },
//       { prefix: '/agents/b', backendPort: 7002, stripPrefix: true },
//     ]});
//
// All routes share one token, scoped (when self-minting) to just the routed
// ports. See docs/routing-spec.html.
import { createProxyServer } from './proxy.mjs';
import { createTokenProvider } from './tokens.mjs';

// Classify routes into 'port' (Mode A), 'prefix' (Mode B), or 'single'.
// Mixing listen and prefix routes in one call is rejected.
function classifyRoutes(opts) {
  const defaultHost = opts.host || '127.0.0.1';
  const list = Array.isArray(opts.routes) ? opts.routes : [];
  const hasPrefix = list.some((r) => r.prefix != null);
  const hasListen = list.some((r) => r.listen != null);
  if (hasPrefix && hasListen) {
    throw new Error('createProxy: routes mix listener-per-port (listen) and path-prefix (prefix) — pick one mode');
  }

  if (hasPrefix) {
    const routes = list.map((r, i) => {
      if (r.backendPort == null) throw new Error(`createProxy: routes[${i}] needs a 'backendPort'`);
      let prefix = String(r.prefix).trim();
      if (!prefix.startsWith('/')) prefix = '/' + prefix;
      if (prefix.length > 1 && prefix.endsWith('/')) prefix = prefix.slice(0, -1);
      return { prefix, backendPort: String(r.backendPort), stripPrefix: r.stripPrefix !== false };
    });
    return { mode: 'prefix', host: defaultHost, listen: Number(opts.port || 3000), routes };
  }

  if (hasListen) {
    const routes = list.map((r, i) => {
      if (r.listen == null) throw new Error(`createProxy: routes[${i}] needs a 'listen' port`);
      if (r.backendPort == null) throw new Error(`createProxy: routes[${i}] needs a 'backendPort'`);
      return { listen: Number(r.listen), host: r.host || defaultHost, backendPort: String(r.backendPort) };
    });
    return { mode: 'port', routes };
  }

  // single-app
  return { mode: 'single', routes: [
    { listen: Number(opts.port || 3000), host: defaultHost, backendPort: String(opts.backendPort || 8080) },
  ] };
}

// Build a resolveRoute(req) for Mode B: longest matching prefix wins; optional
// strip rewrites the upstream path and enables Location rewriting.
function makePrefixResolver(routes) {
  const sorted = [...routes].sort((a, b) => b.prefix.length - a.prefix.length);
  return (req) => {
    const path = req.url || '/';
    for (const r of sorted) {
      if (path === r.prefix || path.startsWith(r.prefix + '/') || path.startsWith(r.prefix + '?') || r.prefix === '/') {
        if (!r.stripPrefix || r.prefix === '/') return { port: r.backendPort, path };
        const rest = path.slice(r.prefix.length) || '/';
        return { port: r.backendPort, path: rest.startsWith('/') ? rest : '/' + rest, prefix: r.prefix };
      }
    }
    return null;   // -> 404
  };
}

/**
 * @param {object} opts
 * @param {string}  opts.endpoint              MicroVM endpoint host (required)
 * @param {number} [opts.port=3000]            local port (single-app & Mode B origin)
 * @param {string} [opts.host='127.0.0.1']     bind address
 * @param {string} [opts.backendPort='8080']   in-VM port to route to (single-app mode)
 * @param {Array} [opts.routes]                Mode A: [{listen,backendPort,host?}]; Mode B: [{prefix,backendPort,stripPrefix?}]
 * @param {Array<number>|string} [opts.allowedPorts]  self-mint token scope; defaults to the routed ports, 'all' to disable scoping
 * @param {string} [opts.token]                static JWE token
 * @param {()=>string|Promise<string>} [opts.getToken]  custom token minter (BYO)
 * @param {string} [opts.microvmId]            self-mint: the MicroVM id
 * @param {string} [opts.region]               self-mint: AWS region
 * @param {string} [opts.awsCli='aws']         self-mint: aws binary path
 * @param {number} [opts.ttlMinutes=60]        self-mint: token TTL
 * @param {(level,msg)=>void} [opts.onLog]
 */
export function createProxy(opts = {}) {
  if (!opts.endpoint) throw new Error('createProxy: endpoint is required');
  const onLog = opts.onLog;
  const log = onLog || (() => {});
  const plan = classifyRoutes(opts);

  // resolve token strategy (one provider shared by every listener)
  const tokenProviderOpts = { onLog };
  if (opts.token) tokenProviderOpts.token = opts.token;
  else if (opts.getToken) tokenProviderOpts.getToken = opts.getToken;
  else if (opts.microvmId) {
    // Scope the self-minted token to exactly the ports we route to (least
    // privilege), unless the caller overrides via allowedPorts.
    const allowedPorts = opts.allowedPorts != null
      ? opts.allowedPorts
      : [...new Set(plan.routes.map((r) => Number(r.backendPort)))];
    tokenProviderOpts.mint = {
      microvmId: opts.microvmId, region: opts.region,
      awsCli: opts.awsCli, ttlMinutes: opts.ttlMinutes, allowedPorts,
    };
  } else throw new Error('createProxy: provide one of { token, getToken, microvmId }');

  const getToken = createTokenProvider(tokenProviderOpts);
  const seam = { _upstreamPort: opts._upstreamPort, _upstreamTls: opts._upstreamTls, _upstreamHost: opts._upstreamHost };  // internal test/demo seam

  // Each entry: { server, bind:{listen,host}, describe:string }
  let instances;
  if (plan.mode === 'prefix') {
    // ONE server fronting one origin, routing by path prefix.
    const resolveRoute = makePrefixResolver(plan.routes);
    instances = [{
      server: createProxyServer({ endpoint: opts.endpoint, resolveRoute, getToken, onLog, ...seam }),
      bind: { listen: plan.listen, host: plan.host },
      describe: plan.routes.map((r) => `${r.prefix}->:${r.backendPort}`).join(' '),
    }];
  } else {
    // One server per local listener (Mode A / single).
    instances = plan.routes.map((r) => ({
      server: createProxyServer({ endpoint: opts.endpoint, backendPort: r.backendPort, getToken, onLog, ...seam }),
      bind: { listen: r.listen, host: r.host },
      describe: `:${r.backendPort}`,
      backendPort: r.backendPort,
    }));
  }

  return {
    server: instances[0].server,   // backwards compatible: first/only server
    servers: instances.map((s) => s.server),
    mode: plan.mode,
    routes: plan.routes,
    listen() {
      return Promise.all(instances.map((inst) => new Promise((resolve) => {
        inst.server.listen(inst.bind.listen, inst.bind.host, () => {
          const url = `http://${inst.bind.host}:${inst.bind.listen}`;
          log('info', `proxy ${url} -> https://${opts.endpoint} (${inst.describe})`);
          resolve({ url, port: inst.bind.listen, host: inst.bind.host, backendPort: inst.backendPort });
        });
      }))).then((urls) => ({ ...urls[0], urls }));   // urls[0] spread keeps {url,port,host} shape
    },
    close() { return Promise.all(instances.map((inst) => new Promise((r) => inst.server.close(r)))).then(() => {}); },
  };
}

// exported for tests
export { classifyRoutes, makePrefixResolver };

export { createProxyServer } from './proxy.mjs';
export { createTokenProvider, mintViaCli, allowedPortsJson } from './tokens.mjs';
export { createPool } from './pool.mjs';
