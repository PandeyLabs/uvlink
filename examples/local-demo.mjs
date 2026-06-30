// Local, no-AWS demo of "one MicroVM, many apps" through uvlink.
//
// A single mock server stands in for a MicroVM endpoint: it demuxes by the
// X-aws-proxy-port header (HTTP) and the lambda-microvms.port subprotocol (WS) —
// exactly what the real platform does — and serves THREE different in-VM apps:
//   :8888  a "Jupyter-ish" HTML page
//   :6006  a "TensorBoard-ish" HTML page + a live WebSocket clock
//   :8080  a JSON API
//
// uvlink then fronts that one endpoint with three local listeners, injecting the
// auth token + the correct port per request. This exercises the SAME proxy.mjs /
// index.mjs code path as a real MicroVM — only the upstream is local + plaintext.
import http from 'node:http';
import crypto from 'node:crypto';
import { createProxy } from '../src/index.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TOKEN = 'demo-token';

// in-VM apps keyed by the port the platform would route to
const APPS = {
  '8888': () => page('JupyterLab (mock)', '#f37726',
    'This page is served by the in-VM app on <b>port 8888</b>, reached through uvlink.'),
  '6006': () => page('TensorBoard (mock)', '#ff6f00',
    'Served by the in-VM app on <b>port 6006</b>. The clock below streams over a ' +
    'WebSocket proxied by uvlink (subprotocol auth injected):' +
    '<div id="clock" style="font-size:32px;margin-top:14px">connecting…</div>' +
    `<script>
      const ws = new WebSocket('ws://' + location.host + '/ws');
      ws.onmessage = e => document.getElementById('clock').textContent = e.data;
      ws.onclose = () => document.getElementById('clock').textContent = 'disconnected';
    </script>`),
};

function page(title, color, body) {
  return `<!doctype html><meta charset=utf-8><title>${title}</title>
  <body style="font:16px system-ui;background:#0a0e16;color:#cfe0f5;margin:0">
  <div style="max-width:640px;margin:60px auto;padding:0 20px">
    <div style="display:inline-block;background:${color};color:#000;padding:4px 12px;border-radius:6px;font-weight:700">${title}</div>
    <h1 style="margin:18px 0 8px">It works ✓</h1>
    <p style="color:#7f9cc4;line-height:1.6">${body}</p>
  </div>`;
}

// ---- the mock "MicroVM endpoint": demux by the port the platform consumes ----
const vm = http.createServer((req, res) => {
  const port = req.headers['x-aws-proxy-port'];            // platform reads this
  if (req.headers['x-aws-proxy-auth'] !== TOKEN) { res.writeHead(403); return res.end('bad token'); }
  if (port === '8080') { res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ app: 'api', servedByInVmPort: 8080, ok: true, ts: new Date().toISOString() })); }
  const app = APPS[port];
  if (!app) { res.writeHead(502); return res.end('no in-VM app on port ' + port); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(app());
});
// WS: only the :6006 app has one; auth + port arrive in the subprotocol list
vm.on('upgrade', (req, sock) => {
  const protos = (req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
  if (!protos.includes('lambda-microvms.authentication.' + TOKEN)) return sock.destroy();
  if (!protos.includes('lambda-microvms.port.6006')) return sock.destroy();
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const tick = () => { const s = Buffer.from('in-VM :6006 clock — ' + new Date().toLocaleTimeString());
    sock.write(Buffer.concat([Buffer.from([0x81, s.length]), s])); };
  tick(); const iv = setInterval(tick, 1000);
  sock.on('close', () => clearInterval(iv)); sock.on('error', () => clearInterval(iv));
});

await new Promise(r => vm.listen(0, '127.0.0.1', r));
const vmPort = vm.address().port;
console.log(`mock MicroVM endpoint listening on 127.0.0.1:${vmPort} (apps on in-VM ports 8888, 6006, 8080)\n`);

// ---- uvlink fronts that one endpoint with three local listeners ----
const proxy = createProxy({
  endpoint: '127.0.0.1',
  token: TOKEN,                       // static token (no AWS needed for the demo)
  routes: [
    { listen: 3000, backendPort: 8888 },
    { listen: 3001, backendPort: 6006 },
    { listen: 3002, backendPort: 8080 },
  ],
  _upstreamPort: vmPort, _upstreamTls: false,   // demo seam: talk plaintext to the local mock
  onLog: (l, m) => console.log(`[${l}] ${m}`),
});

const { urls } = await proxy.listen();
console.log('\n  uvlink is routing — open these:\n');
console.log(`    Jupyter-ish   ${urls[0].url}      (in-VM :8888)`);
console.log(`    TensorBoard   ${urls[1].url}      (in-VM :6006, live WS clock)`);
console.log(`    API (JSON)    ${urls[2].url}      (in-VM :8080)`);
console.log('\n  Ctrl-C to stop.\n');

process.on('SIGINT', async () => { await proxy.close(); vm.close(); process.exit(0); });
