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

/**
 * Create (but do not start) an auth-injecting proxy server.
 *
 * @param {object} opts
 * @param {string} opts.endpoint            MicroVM endpoint host (no scheme)
 * @param {() => (string|Promise<string>)} opts.getToken  returns a current JWE token
 * @param {string} [opts.backendPort='8080'] in-VM port to route to (X-aws-proxy-port)
 * @param {(level,msg)=>void} [opts.onLog]   optional logger
 * @returns {http.Server}
 */
export function createProxyServer(opts) {
  const endpoint = (opts.endpoint || '').trim();
  const backendPort = String(opts.backendPort || DEFAULT_BACKEND_PORT);
  const getToken = opts.getToken;
  const log = opts.onLog || (() => {});
  // internal test seam: point upstream at a plain-HTTP mock instead of :443 TLS
  const upstreamPort = opts._upstreamPort || 443;
  const upstreamTls = opts._upstreamTls !== false;
  if (!endpoint) throw new Error('createProxyServer: endpoint is required');
  if (typeof getToken !== 'function') throw new Error('createProxyServer: getToken() is required');

  const resolveToken = async () => String(await getToken()).trim();

  // ---- HTTP path -----------------------------------------------------------
  const server = http.createServer(async (creq, cres) => {
    let token;
    try { token = await resolveToken(); }
    catch (e) { cres.writeHead(502); cres.end('token error: ' + e.message); return; }

    const headers = {
      ...creq.headers,
      host: endpoint,
      'x-aws-proxy-auth': token,
      'x-aws-proxy-port': backendPort,
    };
    const agent = upstreamTls ? https : http;
    const preq = agent.request(
      { host: endpoint, port: upstreamPort, method: creq.method, path: creq.url, headers,
        servername: upstreamTls ? endpoint : undefined },
      (pres) => {
        cres.writeHead(pres.statusCode, pres.headers);
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

  // ---- WebSocket upgrade path ----------------------------------------------
  server.on('upgrade', async (creq, csock, head) => {
    let token;
    try { token = await resolveToken(); }
    catch (e) { csock.destroy(); log('error', `token error on upgrade: ${e.message}`); return; }

    const connect = upstreamTls
      ? (cb) => tls.connect({ host: endpoint, port: upstreamPort, servername: endpoint }, cb)
      : (cb) => net.connect({ host: endpoint, port: upstreamPort }, cb);
    const usock = connect(() => {
      const headers = {
        ...creq.headers,
        host: endpoint,
        'sec-websocket-protocol': buildWsProtocols(token, backendPort, creq.headers['sec-websocket-protocol']),
      };
      let raw = `${creq.method} ${creq.url} HTTP/1.1\r\n`;
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

// exported for tests
export { buildWsProtocols };
