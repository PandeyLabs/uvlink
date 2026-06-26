// Real-MicroVM integration test for uvlink.
// Spins up the library's proxy (with SELF-MINTING via aws CLI) pointed at a live
// MicroVM, then drives HTTP and a real WebSocket through it — exercising the
// full stack: token mint/refresh, TLS to :443, header + subprotocol injection.
//
// Usage: ENDPOINT=<host> MICROVM_ID=<id> REGION=us-east-1 AWS_CLI=<path> node test/real.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { createProxy } from '../src/index.mjs';

const endpoint = process.env.ENDPOINT;
const microvmId = process.env.MICROVM_ID;
const region = process.env.REGION || 'us-east-1';
const awsCli = process.env.AWS_CLI || 'aws';
if (!endpoint || !microvmId) { console.error('set ENDPOINT and MICROVM_ID'); process.exit(1); }

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log(`  ok  - ${name}`); pass++; }
  catch (e) { console.log(`  FAIL- ${name}: ${e.message}`); fail++; } }

console.log('uvlink — REAL MicroVM test\n  endpoint:', endpoint, '\n');

// Start the library's proxy with self-minting (tests tokens.mjs mint+refresh too)
const proxy = createProxy({
  endpoint, microvmId, region, awsCli, port: 0,   // port 0 = ephemeral
  onLog: (l, m) => console.log(`   [${l}] ${m}`),
});
const { } = await proxy.listen();
const addr = proxy.server.address();
const base = `http://127.0.0.1:${addr.port}`;
console.log('  proxy listening at', base, '\n');

await t('HTTP through proxy reaches the real MicroVM (auth injected by lib)', async () => {
  const body = await new Promise((resolve, reject) => {
    http.get(`${base}/hello`, (res) => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve({code:res.statusCode,b})); }).on('error', reject);
  });
  // A 200 with the backend's JSON proves the lib injected a valid X-aws-proxy-auth
  // (without it the platform returns 403 before reaching the backend) AND routed
  // to the right in-VM port. Note: the platform CONSUMES X-aws-proxy-port itself,
  // so the backend never sees it (sawProxyPort is expected to be null).
  assert.equal(body.code, 200, `status ${body.code} (403 would mean auth not injected)`);
  const j = JSON.parse(body.b);
  assert.equal(j.ok, true, 'backend responded');
  assert.equal(j.path, '/hello', 'path preserved end-to-end');
  assert.equal(j.sawProxyPort, null, 'platform consumes X-aws-proxy-port (backend does not see it)');
});

await t('WebSocket through proxy echoes off the real MicroVM (subprotocols injected by lib)', async () => {
  const key = crypto.randomBytes(16).toString('base64');
  const echo = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/ws`, { headers: {
      Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Protocol': 'my-app-protocol' } });   // app's own subprotocol
    req.on('upgrade', (res, sock) => {
      sock.once('data', (buf) => {
        // unmasked server text frame: header is 2 bytes (len<126)
        resolve(buf.slice(2).toString());
      });
      // send a masked text frame "ping"
      const p = Buffer.from('ping'), mask = crypto.randomBytes(4), m = Buffer.alloc(4);
      for (let i=0;i<4;i++) m[i]=p[i]^mask[i%4];
      sock.write(Buffer.concat([Buffer.from([0x81,0x84]), mask, m]));
    });
    req.on('error', reject);
    req.end();
    setTimeout(() => reject(new Error('ws timeout')), 8000);
  });
  assert.equal(echo, 'echo:ping', 'WS echo round-tripped through the real MicroVM');
});

await t('control: hitting the endpoint WITHOUT the lib is rejected (403)', async () => {
  const https = await import('node:https');
  const code = await new Promise((resolve, reject) => {
    https.get({ host: endpoint, port: 443, path: '/hello', servername: endpoint },
      (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.ok(code === 403 || code === 401, `expected 401/403 without auth, got ${code}`);
});

await proxy.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
