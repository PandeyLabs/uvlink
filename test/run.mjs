// Tests against a local mock "MicroVM endpoint" — no AWS required.
// Verifies the proxy injects the auth header (HTTP) and the lambda-microvms
// subprotocols (WebSocket), and that a real WS echo round-trips through it.
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { createProxyServer, buildWsProtocols, rewriteLocation } from '../src/proxy.mjs';
import { createTokenProvider, allowedPortsJson, classifyRoutes, makePrefixResolver, createPool } from '../src/index.mjs';

let pass = 0, fail = 0;
const ok = (name) => { console.log(`  ok  - ${name}`); pass++; };
const bad = (name, e) => { console.log(`  FAIL- ${name}: ${e.message}`); fail++; };
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

const TOKEN = 'test-jwe-token-abc123';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---- mock MicroVM backend: a plain-HTTP server that records what it received
function startMock() {
  const seen = {};
  const srv = http.createServer((req, res) => {
    seen.http = { authHeader: req.headers['x-aws-proxy-auth'], portHeader: req.headers['x-aws-proxy-port'], url: req.url };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ pong: true }));
  });
  // WebSocket: complete the handshake, echo one frame back
  srv.on('upgrade', (req, sock) => {
    seen.ws = { subprotocols: req.headers['sec-websocket-protocol'] };
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    // read one masked client frame, reply with an unmasked text frame "echo"
    sock.once('data', () => {
      const payload = Buffer.from('echo');
      sock.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, seen })));
}

// minimal masked client text frame
function wsFrame(str) {
  const p = Buffer.from(str), mask = crypto.randomBytes(4), masked = Buffer.alloc(p.length);
  for (let i = 0; i < p.length; i++) masked[i] = p[i] ^ mask[i % 4];
  return Buffer.concat([Buffer.from([0x81, 0x80 | p.length]), mask, masked]);
}

console.log('uvlink tests\n');

// --- unit: subprotocol builder ---
await t('buildWsProtocols includes auth + port + preserves existing', () => {
  const s = buildWsProtocols('TOK', '8080', 'v1.kernel.websocket.jupyter.org');
  assert.ok(s.includes('lambda-microvms'));
  assert.ok(s.includes('lambda-microvms.authentication.TOK'));
  assert.ok(s.includes('lambda-microvms.port.8080'));
  assert.ok(s.includes('v1.kernel.websocket.jupyter.org'));
});

// --- unit: token provider (static + refresh) ---
await t('token provider: static token returned verbatim', async () => {
  const g = createTokenProvider({ token: '  spaced-token  ' });
  assert.equal(await g(), 'spaced-token');
});
await t('token provider: getToken callback + caching', async () => {
  let n = 0;
  const g = createTokenProvider({ getToken: () => `tok-${++n}` });
  const a = await g(); const b = await g();    // cached within TTL
  assert.equal(a, 'tok-1'); assert.equal(b, 'tok-1');
});

// --- integration: HTTP header injection through the proxy ---
const mock = await startMock();
const proxySrv = createProxyServer({
  endpoint: '127.0.0.1', getToken: async () => TOKEN, backendPort: '8080',
  _upstreamPort: mock.port, _upstreamTls: false,
});
await new Promise((r) => proxySrv.listen(0, '127.0.0.1', r));
const proxyPort = proxySrv.address().port;

await t('HTTP: proxy injects X-aws-proxy-auth + X-aws-proxy-port', async () => {
  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${proxyPort}/ping`, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b));
    }).on('error', reject);
  });
  assert.equal(JSON.parse(body).pong, true);
  assert.equal(mock.seen.http.authHeader, TOKEN, 'auth header reached backend');
  assert.equal(mock.seen.http.portHeader, '8080', 'port header reached backend');
  assert.equal(mock.seen.http.url, '/ping', 'path preserved');
});

// --- integration: WebSocket subprotocol injection + echo through the proxy ---
await t('WS: proxy injects lambda-microvms subprotocols and echo round-trips', async () => {
  const key = crypto.randomBytes(16).toString('base64');
  const echo = await new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${proxyPort}/socket`, {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Protocol': 'v1.kernel.websocket.jupyter.org' },
    });
    req.on('upgrade', (res, sock) => {
      sock.once('data', (buf) => {
        // skip the 2-byte unmasked header, read payload
        resolve(buf.slice(2).toString());
      });
      sock.write(wsFrame('hi'));
    });
    req.on('error', reject);
    req.end();
    setTimeout(() => reject(new Error('ws timeout')), 4000);
  });
  assert.equal(echo, 'echo', 'echo frame returned through proxy');
  assert.ok(mock.seen.ws.subprotocols.includes('lambda-microvms.authentication.' + TOKEN), 'token in subprotocols');
  assert.ok(mock.seen.ws.subprotocols.includes('v1.kernel.websocket.jupyter.org'), 'app subprotocol preserved');
});

// --- unit: allowedPortsJson (token scoping) ---
await t('allowedPortsJson: array of ports -> scoped JSON', () => {
  assert.equal(allowedPortsJson([8888, 6006]), '[{"port":8888},{"port":6006}]');
});
await t('allowedPortsJson: comma string -> scoped JSON, deduped', () => {
  assert.equal(allowedPortsJson('8888,6006,8888'), '[{"port":8888},{"port":6006}]');
});
await t("allowedPortsJson: 'all' / empty -> allPorts", () => {
  assert.equal(allowedPortsJson('all'), '[{"allPorts":{}}]');
  assert.equal(allowedPortsJson(), '[{"allPorts":{}}]');
});
await t('allowedPortsJson: raw JSON passed through', () => {
  assert.equal(allowedPortsJson('[{"port":1234}]'), '[{"port":1234}]');
});

// --- integration: per-request resolvePort routes to the right in-VM port ---
// Two proxies front the SAME mock VM but resolve different in-VM ports, the way
// Mode A's listener-per-port works. We assert the port header (HTTP) and the
// lambda-microvms.port subprotocol (WS) each carry the route's port.
await t('multi-app: resolvePort sets X-aws-proxy-port per route (HTTP)', async () => {
  for (const vmPort of ['8888', '6006']) {
    const srv = createProxyServer({
      endpoint: '127.0.0.1', getToken: async () => TOKEN,
      resolvePort: () => vmPort, _upstreamPort: mock.port, _upstreamTls: false,
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const p = srv.address().port;
    await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${p}/`, (res) => { res.on('data', () => {}); res.on('end', resolve); }).on('error', reject);
    });
    assert.equal(mock.seen.http.portHeader, vmPort, `routed to in-VM :${vmPort}`);
    srv.close();
  }
});

await t('multi-app: resolvePort sets lambda-microvms.port subprotocol (WS)', async () => {
  const srv = createProxyServer({
    endpoint: '127.0.0.1', getToken: async () => TOKEN,
    resolvePort: () => '6006', _upstreamPort: mock.port, _upstreamTls: false,
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = srv.address().port;
  const key = crypto.randomBytes(16).toString('base64');
  await new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${p}/socket`, {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key },
    });
    req.on('upgrade', (res, sock) => { sock.once('data', () => resolve()); sock.write(wsFrame('hi')); });
    req.on('error', reject);
    req.end();
    setTimeout(() => reject(new Error('ws timeout')), 4000);
  });
  assert.ok(mock.seen.ws.subprotocols.includes('lambda-microvms.port.6006'), 'routed WS to in-VM :6006');
  srv.close();
});

// --- integration: a resolver returning null is a 404 (no route) ---
await t('multi-app: resolvePort -> null yields 404', async () => {
  const srv = createProxyServer({
    endpoint: '127.0.0.1', getToken: async () => TOKEN,
    resolvePort: () => null, _upstreamPort: mock.port, _upstreamTls: false,
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = srv.address().port;
  const code = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${p}/nope`, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
  assert.equal(code, 404, 'no route -> 404');
  srv.close();
});

// --- unit: prefix resolver (Mode B) — longest match, strip, path rewrite ---
await t('makePrefixResolver: longest prefix wins + strips', () => {
  const r = makePrefixResolver([
    { prefix: '/a', backendPort: '7001', stripPrefix: true },
    { prefix: '/a/deep', backendPort: '7009', stripPrefix: true },
  ]);
  assert.deepEqual(r({ url: '/a/deep/x' }), { port: '7009', path: '/x', prefix: '/a/deep' });
  assert.deepEqual(r({ url: '/a/y' }), { port: '7001', path: '/y', prefix: '/a' });
  assert.equal(r({ url: '/a' }).path, '/', 'bare prefix -> /');
  assert.equal(r({ url: '/nope' }), null, 'unmatched -> null');
});
await t('makePrefixResolver: no-strip keeps the full path', () => {
  const r = makePrefixResolver([{ prefix: '/a', backendPort: '7001', stripPrefix: false }]);
  assert.deepEqual(r({ url: '/a/y' }), { port: '7001', path: '/a/y' });
});

// --- unit: classifyRoutes picks the mode and rejects mixing ---
await t('classifyRoutes: detects prefix / port / single', () => {
  assert.equal(classifyRoutes({ routes: [{ prefix: '/a', backendPort: 1 }] }).mode, 'prefix');
  assert.equal(classifyRoutes({ routes: [{ listen: 3000, backendPort: 1 }] }).mode, 'port');
  assert.equal(classifyRoutes({}).mode, 'single');
});
await t('classifyRoutes: rejects mixing listen + prefix', () => {
  assert.throws(() => classifyRoutes({ routes: [{ listen: 3000, backendPort: 1 }, { prefix: '/a', backendPort: 2 }] }), /pick one mode/);
});

// --- unit: rewriteLocation re-adds a stripped prefix ---
await t('rewriteLocation: re-adds prefix to absolute-path redirects only', () => {
  assert.equal(rewriteLocation({ location: '/login' }, '/a').location, '/a/login');
  assert.equal(rewriteLocation({ location: 'https://x/y' }, '/a').location, 'https://x/y', 'absolute URL untouched');
  assert.equal(rewriteLocation({ location: '//evil' }, '/a').location, '//evil', 'protocol-relative untouched');
  assert.equal(rewriteLocation({}, '/a').location, undefined, 'no Location -> nothing');
});

// --- integration: prefix mode through a real proxy server, both apps + WS ---
await t('prefix mode: one origin routes /a and /b to different in-VM ports + strips path', async () => {
  const srv = createProxyServer({
    endpoint: '127.0.0.1', getToken: async () => TOKEN,
    resolveRoute: makePrefixResolver([
      { prefix: '/a', backendPort: '7001', stripPrefix: true },
      { prefix: '/b', backendPort: '7002', stripPrefix: true },
    ]),
    _upstreamPort: mock.port, _upstreamTls: false,
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = srv.address().port;
  const get = (path) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${p}${path}`, (res) => { res.on('data', () => {}); res.on('end', resolve); }).on('error', reject);
  });
  await get('/a/info');
  assert.equal(mock.seen.http.portHeader, '7001', '/a -> :7001');
  assert.equal(mock.seen.http.url, '/info', 'prefix /a stripped from upstream path');
  await get('/b/status');
  assert.equal(mock.seen.http.portHeader, '7002', '/b -> :7002');
  assert.equal(mock.seen.http.url, '/status', 'prefix /b stripped');

  // WS under a prefix must route + strip the same way
  const key = crypto.randomBytes(16).toString('base64');
  await new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${p}/b/ws`, {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key },
    });
    req.on('upgrade', (res, sock) => { sock.once('data', () => resolve()); sock.write(wsFrame('hi')); });
    req.on('error', reject); req.end();
    setTimeout(() => reject(new Error('ws timeout')), 4000);
  });
  assert.ok(mock.seen.ws.subprotocols.includes('lambda-microvms.port.7002'), 'WS /b -> :7002');
  srv.close();
});

// --- integration: createPool round-robins + injects auth via the shared core ---
await t('pool: round-robins targets, injects auth + x-served-by', async () => {
  const pool = createPool({
    targets: [
      { endpoint: 'vm-a', getToken: async () => TOKEN },
      { endpoint: 'vm-b', getToken: async () => TOKEN },
    ],
    backendPort: '8080', _upstreamPort: mock.port, _upstreamTls: false, _upstreamHost: '127.0.0.1',
  });
  await pool.listen(0, '127.0.0.1');
  const p = pool.server.address().port;
  const served = [];
  for (let i = 0; i < 2; i++) {
    const sb = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${p}/`, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.headers['x-served-by'])); }).on('error', reject);
    });
    served.push(sb);
  }
  assert.equal(mock.seen.http.authHeader, TOKEN, 'pool injected auth header');
  assert.deepEqual(served.sort(), ['vm-a', 'vm-b'], 'round-robined across both targets');
  await pool.close();
});

proxySrv.close(); mock.srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
