// Example: front several agents on ONE MicroVM behind a SINGLE origin (Mode B).
//
// A common pattern is to run several agent processes inside one Firecracker
// microVM, each on its own in-VM port, plus a console UI. With path-prefix
// routing the browser sees one origin (http://localhost:3000) and selects an
// agent by path — so a console page can talk to every agent same-origin, no
// CORS. uvlink strips the prefix before forwarding and rewrites Location
// redirects, for both HTTP and WebSocket.
//
//   node examples/multi-agent.mjs <microvm-id> [region]
//   then open http://localhost:3000/console
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createProxy } from '../src/index.mjs';

const exec = promisify(execFile);
const microvmId = process.argv[2];
const region = process.argv[3] || 'us-east-1';
if (!microvmId) { console.error('usage: node examples/multi-agent.mjs <microvm-id> [region]'); process.exit(1); }

// look up the endpoint from the id via the aws CLI
const { stdout } = await exec('aws', ['lambda-microvms', 'get-microvm',
  '--microvm-identifier', microvmId, '--region', region, '--query', 'endpoint', '--output', 'text']);
const endpoint = stdout.trim();

const proxy = createProxy({
  endpoint, microvmId, region, port: 3000,
  routes: [
    { prefix: '/console', backendPort: 7000, stripPrefix: true },   // control UI
    { prefix: '/agent-a', backendPort: 7001, stripPrefix: true },   // researcher
    { prefix: '/agent-b', backendPort: 7002, stripPrefix: true },   // coder
    { prefix: '/agent-c', backendPort: 7003, stripPrefix: true },   // reviewer
  ],
  // token auto-scoped to [7000,7001,7002,7003]; pass allowedPorts: 'all' to disable.
  onLog: (l, m) => console.log(`[${l}] ${m}`),
});

const { urls } = await proxy.listen();
const origin = urls[0].url;
console.log('');
for (const r of proxy.routes) console.log(`  ✓ open ${origin}${r.prefix}  ->  in-VM :${r.backendPort}`);
console.log('');

process.on('SIGINT', async () => { await proxy.close(); process.exit(0); });
