// Core auth-injecting reverse proxy for AWS Lambda MicroVM endpoints.
//
// A browser cannot attach the credential a MicroVM endpoint requires:
//   - HTTP requests need the  X-aws-proxy-auth  header (+ X-aws-proxy-port)
//   - WebSocket upgrades carry the token via the lambda-microvms subprotocols
// This proxy terminates the browser connection and re-issues it to the HTTPS
// endpoint with the credential injected, for both protocols.
//
// Zero runtime dependencies — Node built-ins only.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';

const DEFAULT_BACKEND_PORT = '8080';

// Build the Sec-WebSocket-Protocol value the MicroVM endpoint expects, while
// preserving whatever subprotocol the browser/app requested (e.g. Jupyter's
// "v1.kernel.websocket.jupyter.org") so negotiation still succeeds.
function buildWsProtocols(token, backendPort, existing) {
  const protos = [
    'lambda-microvms',
    `lambda-microvms.authentication.${token}`,
    `lambda-microvms.port.${backendPort}`,
  ];
  if (existing) protos.push(existing);
  return protos.join(', ');
}

// When an app is mounted under a stripped path prefix, its root-absolute
// redirects (Location: /login) must be rewritten to re-add the prefix
// (Location: /agents/a/login), or the browser leaves the route. Only touches
// same-origin absolute-path Locations; absolute URLs and relative ones pass through.
function rewriteLocation(headers, prefix) {
  if (!prefix) return headers;
  const loc = headers.location;
  if (!loc || !loc.startsWith('/') || loc.startsWith('//')) return headers;
  return { ...headers, location: prefix + loc };
}

// Shared forwarding core for HTTP + WebSocket. Both createProxyServer (single
// target) and createPool (round-robin over targets) attach this to an http
// server, differing only in their resolveTarget(req). A target is
//   { endpoint, getToken, port, path?, prefix?, servedBy? } | null  (null -> 404).
// This is the one place auth injection, error handling, and the test seam live,
// so the two public entry points can't drift apart.
function attachProxy(server, opts) {
  const resolveTarget = opts.resolveTarget;
  const log = opts.onLog || (() => {});
  const upstreamPort = opts._upstreamPort || 443;
  const upstreamTls = opts._upstreamTls !== false;
  // test seam: connect here instead of the (possibly unresolvable) endpoint label
  const connectHost = (t) => opts._upstreamHost || t.endpoint;
  const tokenOf = async (t) => String(await t.getToken()).trim();

  // ---- HTTP path ----
  server.on('request', async (creq, cres) => {
    let target;
    try { target = await resolveTarget(creq); }
    catch (e) { cres.writeHead(502); cres.end('route error: ' + e.message); return; }
    if (target == null) { cres.writeHead(404); cres.end('uvlink: no route for ' + creq.url); return; }

    let token;
    try { token = await tokenOf(target); }
    catch (e) { cres.writeHead(502); cres.end('token error: ' + e.message); return; }

    const path = target.path != null ? target.path : creq.url;
    const headers = {
      ...creq.headers,
      host: target.endpoint,
      'x-aws-proxy-auth': token,
      'x-aws-proxy-port': String(target.port),
    };
    const agent = upstreamTls ? https : http;
    const preq = agent.request(
      { host: connectHost(target), port: upstreamPort, method: creq.method, path, headers,
        servername: upstreamTls ? target.endpoint : undefined },
      (pres) => {
        let resHeaders = rewriteLocation(pres.headers, target.prefix);
        if (target.servedBy) resHeaders = { ...resHeaders, 'x-served-by': target.servedBy };
        cres.writeHead(pres.statusCode, resHeaders);
        pres.pipe(cres);
      }
    );
    preq.on('error', (e) => {
      log('error', `http upstream: ${e.message}`);
      if (!cres.headersSent) cres.writeHead(502);
      cres.end('upstream error: ' + e.message);
    });
    creq.pipe(preq);
  });

  // ---- WebSocket upgrade path ----
  // Must resolve the target the SAME way the HTTP path does, or a WS (e.g. a
  // Jupyter kernel) lands on the wrong app's in-VM port / path.
  server.on('upgrade', async (creq, csock, head) => {
    let target;
    try { target = await resolveTarget(creq); }
    catch (e) { csock.destroy(); log('error', `route error on upgrade: ${e.message}`); return; }
    if (target == null) { csock.destroy(); log('error', `no route for upgrade ${creq.url}`); return; }

    let token;
    try { token = await tokenOf(target); }
    catch (e) { csock.destroy(); log('error', `token error on upgrade: ${e.message}`); return; }

    const path = target.path != null ? target.path : creq.url;
    const connect = upstreamTls
      ? (cb) => tls.connect({ host: connectHost(target), port: upstreamPort, servername: target.endpoint }, cb)
      : (cb) => net.connect({ host: connectHost(target), port: upstreamPort }, cb);
    const usock = connect(() => {
      const headers = {
        ...creq.headers,
        host: target.endpoint,
        'sec-websocket-protocol': buildWsProtocols(token, String(target.port), creq.headers['sec-websocket-protocol']),
      };
      let raw = `${creq.method} ${path} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`;
      raw += '\r\n';
      usock.write(raw);
      if (head && head.length) usock.write(head);
      usock.pipe(csock);
      csock.pipe(usock);
    });
    usock.on('error', (e) => { log('error', `ws upstream: ${e.message}`); csock.destroy(); });
    csock.on('error', () => usock.destroy());
  });

  return server;
}

/**
 * Create (but do not start) an auth-injecting proxy server.
 *
 * Routing is PER REQUEST. The in-VM port (and, optionally, a rewritten upstream
 * path) is chosen for each request — this is the seam that lets a single proxy
 * front several apps on one MicroVM (see docs/routing-spec.html). Three ways,
 * lowest to highest power:
 *   - `backendPort`            fixed in-VM port (single-app, the common case)
 *   - `resolvePort(req)`       return the in-VM port per request
 *   - `resolveRoute(req)`      return { port, path?, prefix? } per request
 * For resolvePort/resolveRoute, returning null/undefined means "no route" → 404.
 * `path` (when present) is the path sent upstream; `prefix` enables Location-
 * header rewriting so an app mounted under a stripped prefix still redirects
 * correctly in the browser.
 *
 * @param {object} opts
 * @param {string} opts.endpoint            MicroVM endpoint host (no scheme)
 * @param {() => (string|Promise<string>)} opts.getToken  returns a current JWE token
 * @param {string|number} [opts.backendPort='8080'] fixed in-VM port (X-aws-proxy-port)
 * @param {(req)=>(string|number|null)} [opts.resolvePort] per-request in-VM port
 * @param {(req)=>({port:string|number,path?:string,prefix?:string}|null)} [opts.resolveRoute] per-request full route
 * @param {(level,msg)=>void} [opts.onLog]   optional logger
 * @returns {http.Server}
 */
export function createProxyServer(opts) {
  const endpoint = (opts.endpoint || '').trim();
  const getToken = opts.getToken;
  if (!endpoint) throw new Error('createProxyServer: endpoint is required');
  if (typeof getToken !== 'function') throw new Error('createProxyServer: getToken() is required');

  // Normalize the route strategy to a single resolveTarget(req). resolveRoute /
  // resolvePort / backendPort are progressively simpler shapes over one endpoint.
  let routeOf;
  if (typeof opts.resolveRoute === 'function') {
    routeOf = (req) => {
      const r = opts.resolveRoute(req);
      if (r == null) return null;
      const route = (typeof r === 'object') ? r : { port: r };
      return { port: route.port, path: route.path != null ? route.path : req.url, prefix: route.prefix };
    };
  } else if (typeof opts.resolvePort === 'function') {
    routeOf = (req) => { const p = opts.resolvePort(req); return p == null ? null : { port: p, path: req.url }; };
  } else {
    const p = String(opts.backendPort || DEFAULT_BACKEND_PORT);
    routeOf = (req) => ({ port: p, path: req.url });
  }

  const server = http.createServer();
  return attachProxy(server, {
    onLog: opts.onLog, _upstreamPort: opts._upstreamPort, _upstreamTls: opts._upstreamTls,
    resolveTarget: (req) => {
      const route = routeOf(req);
      return route == null ? null : { endpoint, getToken, port: route.port, path: route.path, prefix: route.prefix };
    },
  });
}

// exported for tests + reuse
export { buildWsProtocols, rewriteLocation, attachProxy };
