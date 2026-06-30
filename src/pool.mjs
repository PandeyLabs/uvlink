// Optional: round-robin a single browser-facing port across MULTIPLE MicroVM
// endpoints, each with its own token. This is a convenience for fan-out; for a
// full autoscaler/load balancer (pooling, scaling, recycling) see the companion
// project. Off by default — most users proxy to one VM.
//
// It shares the proxy core (attachProxy) with createProxyServer — the only
// difference is the resolver, which round-robins over targets instead of using
// one endpoint. That keeps auth injection, WS handling, and error paths in one
// place rather than a second copy that drifts.
import http from 'node:http';
import { attachProxy } from './proxy.mjs';

/**
 * @param {object} opts
 * @param {Array<{endpoint:string, getToken:()=>string|Promise<string>}>} opts.targets
 * @param {string} [opts.backendPort='8080']
 * @param {(level,msg)=>void} [opts.onLog]
 */
export function createPool(opts = {}) {
  const targets = opts.targets || [];
  const backendPort = String(opts.backendPort || '8080');
  const log = opts.onLog || (() => {});
  if (!targets.length) throw new Error('createPool: at least one target required');

  let cursor = 0;
  const next = () => { const t = targets[cursor % targets.length]; cursor = (cursor + 1) % targets.length; return t; };

  const server = http.createServer();
  attachProxy(server, {
    onLog: opts.onLog, _upstreamPort: opts._upstreamPort, _upstreamTls: opts._upstreamTls, _upstreamHost: opts._upstreamHost,
    resolveTarget: () => {
      const t = next();
      return { endpoint: t.endpoint, getToken: t.getToken, port: backendPort, servedBy: t.endpoint };
    },
  });

  return {
    server,
    listen(port = 3000, host = '127.0.0.1') {
      return new Promise((r) => server.listen(port, host, () => {
        log('info', `pool on http://${host}:${port} (${targets.length} targets)`);
        r({ url: `http://${host}:${port}` });
      }));
    },
    close() { return new Promise((r) => server.close(r)); },
  };
}
