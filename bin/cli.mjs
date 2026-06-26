#!/usr/bin/env node
// uvlink CLI — start a browser bridge to a MicroVM endpoint.
//
//   npx uvlink --microvm-id microvm-… --region us-east-1 --port 3000
//   npx uvlink --endpoint xxxx.lambda-microvm.us-east-1.on.aws --token <jwe>
//
// With --microvm-id, the endpoint is looked up and the token is self-minted and
// auto-refreshed via the aws CLI. With --endpoint + --token you supply both.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createProxy } from '../src/index.mjs';

const exec = promisify(execFile);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { o.help = true; continue; }
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; o[k] = v; i++; }
  }
  return o;
}

const HELP = `uvlink — a browser bridge for AWS Lambda MicroVMs

Usage:
  uvlink --microvm-id <id> [--region <r>] [--port 3000]
  uvlink --endpoint <host> --token <jwe> [--port 3000]

Options:
  --microvm-id <id>   MicroVM id; endpoint is looked up, token self-minted + refreshed
  --endpoint <host>   MicroVM endpoint host (no scheme); required if no --microvm-id
  --token <jwe>       static token (skip self-minting)
  --region <r>        AWS region (for --microvm-id lookup/mint)
  --backend-port <p>  in-VM port to route to (default 8080)
  --port <p>          local port to listen on (default 3000)
  --host <h>          bind address (default 127.0.0.1)
  --aws-cli <path>    aws binary (default "aws")
  -h, --help

Then open http://localhost:<port> in your browser.`;

async function lookupEndpoint(microvmId, region, awsCli) {
  const args = ['lambda-microvms', 'get-microvm', '--microvm-identifier', microvmId,
    '--query', 'endpoint', '--output', 'text'];
  if (region) args.push('--region', region);
  const { stdout } = await exec(awsCli, args);
  return stdout.trim();
}

const args = parseArgs(process.argv.slice(2));
if (args.help || (!args['microvm-id'] && !args.endpoint)) { console.log(HELP); process.exit(args.help ? 0 : 1); }

const awsCli = args['aws-cli'] || 'aws';
const log = (lvl, msg) => console.log(`[${lvl}] ${msg}`);

let endpoint = args.endpoint;
const proxyOpts = {
  port: Number(args.port || 3000),
  host: args.host || '127.0.0.1',
  backendPort: args['backend-port'] || '8080',
  onLog: log,
};

if (args['microvm-id']) {
  if (!endpoint) {
    try { endpoint = await lookupEndpoint(args['microvm-id'], args.region, awsCli); log('info', `endpoint ${endpoint}`); }
    catch (e) { console.error('failed to look up endpoint:', e.message); process.exit(1); }
  }
  proxyOpts.microvmId = args['microvm-id'];
  proxyOpts.region = args.region;
  proxyOpts.awsCli = awsCli;
}
if (args.token) { delete proxyOpts.microvmId; proxyOpts.token = args.token; }
proxyOpts.endpoint = endpoint;

const proxy = createProxy(proxyOpts);
const { url } = await proxy.listen();
console.log(`\n  ✓ open ${url} in your browser\n`);

process.on('SIGINT', async () => { await proxy.close(); process.exit(0); });
