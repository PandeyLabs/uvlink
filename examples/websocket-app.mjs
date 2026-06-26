// Example: a WebSocket app (chat, terminal, live dashboard) on a MicroVM,
// reached from the browser. The WS upgrade gets the lambda-microvms auth
// subprotocols injected automatically; your app's own subprotocol (if any) is
// preserved. Uses a custom getToken so you can plug in your own minting.
//
//   ENDPOINT=xxxx.lambda-microvm.us-east-1.on.aws node examples/websocket-app.mjs
import { createProxy } from '../src/index.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const endpoint = process.env.ENDPOINT;
const microvmId = process.env.MICROVM_ID;       // optional, for self-minting via getToken
const region = process.env.REGION || 'us-east-1';
if (!endpoint) { console.error('set ENDPOINT (and MICROVM_ID to mint tokens)'); process.exit(1); }

// custom minter example — you could call the SDK, your control plane, etc.
async function getToken() {
  const { stdout } = await exec('aws', ['lambda-microvms', 'create-microvm-auth-token',
    '--microvm-identifier', microvmId, '--region', region,
    '--expiration-in-minutes', '60', '--allowed-ports', '[{"allPorts":{}}]',
    '--query', 'authToken."X-aws-proxy-auth"', '--output', 'text']);
  return stdout.trim();
}

const proxy = createProxy({ endpoint, getToken, port: 3000, onLog: console.log.bind(null, '[log]') });
await proxy.listen();
console.log('\n  ✓ open http://localhost:3000 — WebSockets proxied with auth\n');
