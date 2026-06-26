// uvlink — a browser bridge for AWS Lambda MicroVMs.
//
// Public API:
//   import { createProxy } from 'uvlink';
//   const proxy = createProxy({ endpoint, microvmId, region, port });
//   await proxy.listen();   // browser -> http://localhost:<port>
//
// Token supply (pick one): { token } | { getToken } | { microvmId, region }.
// The last self-mints via the aws CLI and auto-refreshes.
import { createProxyServer } from './proxy.mjs';
import { createTokenProvider } from './tokens.mjs';

/**
 * @param {object} opts
 * @param {string}  opts.endpoint              MicroVM endpoint host (required)
 * @param {number} [opts.port=3000]            local port to listen on
 * @param {string} [opts.host='127.0.0.1']     bind address
 * @param {string} [opts.backendPort='8080']   in-VM port to route to
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
  const port = opts.port || 3000;
  const host = opts.host || '127.0.0.1';
  const onLog = opts.onLog;

  // resolve token strategy
  const tokenProviderOpts = { onLog };
  if (opts.token) tokenProviderOpts.token = opts.token;
  else if (opts.getToken) tokenProviderOpts.getToken = opts.getToken;
  else if (opts.microvmId) tokenProviderOpts.mint = {
    microvmId: opts.microvmId, region: opts.region,
    awsCli: opts.awsCli, ttlMinutes: opts.ttlMinutes,
  };
  else throw new Error('createProxy: provide one of { token, getToken, microvmId }');

  const getToken = createTokenProvider(tokenProviderOpts);
  const server = createProxyServer({
    endpoint: opts.endpoint, backendPort: opts.backendPort, getToken, onLog,
  });

  return {
    server,
    listen() {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          (onLog || (() => {}))('info', `proxy http://${host}:${port} -> https://${opts.endpoint}`);
          resolve({ url: `http://${host}:${port}`, port, host });
        });
      });
    },
    close() { return new Promise((r) => server.close(r)); },
  };
}

export { createProxyServer } from './proxy.mjs';
export { createTokenProvider, mintViaCli } from './tokens.mjs';
export { createPool } from './pool.mjs';
