// Test backend for verifying uvlink against a real MicroVM.
// HTTP: returns JSON + echoes which subprotocols/headers it received.
// WebSocket: echoes back any text frame, prefixed with "echo:".
// Zero deps (raw WS handshake + framing).
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8080);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    path: req.url,
    // prove the proxy delivered auth context to the backend
    sawProxyPort: req.headers['x-aws-proxy-port'] || null,
    note: 'http reached the MicroVM backend',
  }));
});

// minimal WebSocket echo
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);

  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // parse one masked client text frame at a time
    while (buf.length >= 2) {
      const len0 = buf[1] & 0x7f;
      let off = 2, len = len0;
      if (len0 === 126) { len = buf.readUInt16BE(2); off = 4; }
      const masked = (buf[1] & 0x80) !== 0;
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) break;
      const mask = masked ? buf.slice(off, off + 4) : null;
      const dataStart = off + (masked ? 4 : 0);
      const data = Buffer.alloc(len);
      for (let i = 0; i < len; i++) data[i] = buf[dataStart + i] ^ (mask ? mask[i % 4] : 0);
      buf = buf.slice(need);
      const reply = Buffer.from('echo:' + data.toString());
      const header = reply.length < 126
        ? Buffer.from([0x81, reply.length])
        : (() => { const h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(reply.length, 2); return h; })();
      sock.write(Buffer.concat([header, reply]));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`echo backend on :${PORT}`));
