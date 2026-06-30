// Example: reach SEVERAL apps running on ONE MicroVM, from the browser.
//
// A single MicroVM image often starts more than one service on different
// in-VM ports — e.g. JupyterLab on 8888 and TensorBoard on 6006. uvlink's
// Mode A (listener-per-port) binds one local port per app and routes each to
// its in-VM port, all sharing one auto-refreshed token scoped to just those
// ports.
//
//   node examples/multi-app.mjs <microvm-id> [region]
//   then open the printed URLs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createProxy } from '../src/index.mjs';

const exec = promisify(execFile);
const microvmId = process.argv[2];
const region = process.argv[3] || 'us-east-1';
if (!microvmId) { console.error('usage: node examples/multi-app.mjs <microvm-id> [region]'); process.exit(1); }

// look up the endpoint from the id via the aws CLI
const { stdout } = await exec('aws', ['lambda-microvms', 'get-microvm',
  '--microvm-identifier', microvmId, '--region', region, '--query', 'endpoint', '--output', 'text']);
const endpoint = stdout.trim();

const proxy = createProxy({
  endpoint, microvmId, region,
  routes: [
    { listen: 3000, backendPort: 8888 },   // JupyterLab
    { listen: 3001, backendPort: 6006 },   // TensorBoard
  ],
  // token is auto-scoped to [8888, 6006]; pass allowedPorts: 'all' to disable.
  onLog: (l, m) => console.log(`[${l}] ${m}`),
});

const { urls } = await proxy.listen();
console.log('');
console.log(`  ✓ JupyterLab    ${urls[0].url}/lab`);
console.log(`  ✓ TensorBoard   ${urls[1].url}`);
console.log('');

process.on('SIGINT', async () => { await proxy.close(); process.exit(0); });
