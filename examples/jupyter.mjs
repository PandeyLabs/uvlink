// Example: open a JupyterLab MicroVM in your browser.
//
// Jupyter's kernel uses WebSockets with its own subprotocol
// (v1.kernel.websocket.jupyter.org) — uvlink preserves it while adding
// the lambda-microvms auth subprotocols, so cell execution works in the browser.
//
//   node examples/jupyter.mjs <microvm-id> [region]
//   then open http://localhost:3000/lab
import { createProxy } from '../src/index.mjs';

const microvmId = process.argv[2];
const region = process.argv[3] || 'us-east-1';
if (!microvmId) { console.error('usage: node examples/jupyter.mjs <microvm-id> [region]'); process.exit(1); }

// look up the endpoint from the id via the aws CLI
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const { stdout } = await exec('aws', ['lambda-microvms', 'get-microvm',
  '--microvm-identifier', microvmId, '--region', region, '--query', 'endpoint', '--output', 'text']);
const endpoint = stdout.trim();

const proxy = createProxy({
  endpoint, microvmId, region, port: 3000,
  onLog: (l, m) => console.log(`[${l}] ${m}`),
});
await proxy.listen();
console.log('\n  ✓ open http://localhost:3000/lab\n');
