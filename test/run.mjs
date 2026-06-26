// Tests against a local mock "MicroVM endpoint" — no AWS required.
// Verifies the proxy injects the auth header (HTTP) and the lambda-microvms
// subprotocols (WebSocket), and that a real WS echo round-trips through it.
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { createProxyServer, buildWsProtocols } from '../src/proxy.mjs';
import { createTokenProvider } from '../src/index.mjs';

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

proxySrv.close(); mock.srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
