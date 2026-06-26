// Optional: round-robin a single browser-facing port across MULTIPLE MicroVM
// endpoints, each with its own token. This is a convenience for fan-out; for a
// full autoscaler/load balancer (pooling, scaling, recycling) see the companion
// project. Off by default — most users proxy to one VM.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { buildWsProtocols } from './proxy.mjs';

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

  const server = http.createServer(async (creq, cres) => {
    const t = next();
    let token;
    try { token = String(await t.getToken()).trim(); }
    catch (e) { cres.writeHead(502); cres.end('token error: ' + e.message); return; }
    const preq = https.request(
      { host: t.endpoint, port: 443, method: creq.method, path: creq.url,
        headers: { ...creq.headers, host: t.endpoint, 'x-aws-proxy-auth': token, 'x-aws-proxy-port': backendPort } },
      (pres) => { cres.writeHead(pres.statusCode, { ...pres.headers, 'x-served-by': t.endpoint }); pres.pipe(cres); });
    preq.on('error', (e) => { if (!cres.headersSent) cres.writeHead(502); cres.end('upstream: ' + e.message); });
    creq.pipe(preq);
  });

  server.on('upgrade', async (creq, csock, head) => {
    const t = next();
    let token;
    try { token = String(await t.getToken()).trim(); } catch { csock.destroy(); return; }
    const usock = tls.connect({ host: t.endpoint, port: 443, servername: t.endpoint }, () => {
      const headers = { ...creq.headers, host: t.endpoint,
        'sec-websocket-protocol': buildWsProtocols(token, backendPort, creq.headers['sec-websocket-protocol']) };
      let raw = `${creq.method} ${creq.url} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`;
      raw += '\r\n';
      usock.write(raw); if (head?.length) usock.write(head);
      usock.pipe(csock); csock.pipe(usock);
    });
    usock.on('error', () => csock.destroy());
    csock.on('error', () => usock.destroy());
  });

  return {
    server,
    listen(port = 3000, host = '127.0.0.1') {
      return new Promise((r) => server.listen(port, host, () => { log('info', `pool on http://${host}:${port} (${targets.length} targets)`); r({ url: `http://${host}:${port}` }); }));
    },
    close() { return new Promise((r) => server.close(r)); },
  };
}
