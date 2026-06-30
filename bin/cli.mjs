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

// Flags that may repeat accumulate into an array (e.g. --map a:b --map c:d).
const REPEATABLE = new Set(['map', 'route']);
// Boolean flags take no value.
const BOOLEAN = new Set(['strip-prefix', 'no-strip-prefix']);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { o.help = true; continue; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (BOOLEAN.has(k)) { o[k] = true; continue; }
      const v = argv[i + 1]; i++;
      if (REPEATABLE.has(k)) (o[k] ||= []).push(v);
      else o[k] = v;
    }
  }
  return o;
}

// Parse a "--map local:vm" value into { listen, backendPort }.
function parseMap(spec) {
  const m = /^(\d+):(\d+)$/.exec(String(spec).trim());
  if (!m) throw new Error(`--map expects local:vm (e.g. 3000:8888), got "${spec}"`);
  return { listen: Number(m[1]), backendPort: Number(m[2]) };
}

// Parse a "--route /prefix=vmPort" value into { prefix, backendPort }.
function parseRoute(spec) {
  const m = /^(\/[^=]*)=(\d+)$/.exec(String(spec).trim());
  if (!m) throw new Error(`--route expects /prefix=vmPort (e.g. /agent-a=7001), got "${spec}"`);
  return { prefix: m[1], backendPort: Number(m[2]) };
}

const HELP = `uvlink — a browser bridge for AWS Lambda MicroVMs

Usage:
  uvlink --microvm-id <id> [--region <r>] [--port 3000]
  uvlink --endpoint <host> --token <jwe> [--port 3000]
  uvlink --microvm-id <id> --map 3000:8888 --map 3001:6006        # many apps, many local ports
  uvlink --microvm-id <id> --port 3000 \\
         --route /agent-a=7001 --route /agent-b=7002              # many apps, ONE origin (by path)

Options:
  --microvm-id <id>     MicroVM id; endpoint is looked up, token self-minted + refreshed
  --endpoint <host>     MicroVM endpoint host (no scheme); required if no --microvm-id
  --token <jwe>         static token (skip self-minting)
  --region <r>          AWS region (for --microvm-id lookup/mint)
  --map <local:vm>      Mode A: map a local port to an in-VM port; repeat per app
  --route </p=vmPort>   Mode B: route a path prefix on --port to an in-VM port; repeat per app
  --strip-prefix        Mode B: strip the prefix before forwarding (default on)
  --no-strip-prefix     Mode B: forward the path unchanged (app is mounted under the prefix)
  --backend-port <p>    single-app: in-VM port to route to (default 8080)
  --port <p>            local port (single-app, or the Mode B origin; default 3000)
  --allowed-ports <l>   token scope: comma list of in-VM ports, or "all"
                        (defaults to the ports you --map / --route to)
  --host <h>            bind address (default 127.0.0.1)
  --aws-cli <path>      aws binary (default "aws")
  -h, --help

Then open the printed URL(s) in your browser.

Personal hobby project — not affiliated with, supported by, or endorsed by
AWS / Lambda / Amazon. MIT licensed, provided as-is.`;

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
const proxyOpts = { host: args.host || '127.0.0.1', onLog: log };

// Mode A (--map) | Mode B (--route) | single-app.
if (args.map && args.route) { console.error('use --map (separate ports) OR --route (one origin by path), not both'); process.exit(1); }
if (args.map) {
  try { proxyOpts.routes = args.map.map(parseMap); }
  catch (e) { console.error(e.message); process.exit(1); }
} else if (args.route) {
  const strip = args['no-strip-prefix'] ? false : true;
  try { proxyOpts.routes = args.route.map((s) => ({ ...parseRoute(s), stripPrefix: strip })); }
  catch (e) { console.error(e.message); process.exit(1); }
  proxyOpts.port = Number(args.port || 3000);
} else {
  proxyOpts.port = Number(args.port || 3000);
  proxyOpts.backendPort = args['backend-port'] || '8080';
}
if (args['allowed-ports']) proxyOpts.allowedPorts = args['allowed-ports'];

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
const { urls } = await proxy.listen();
console.log('');
if (proxy.mode === 'prefix') {
  const origin = urls[0].url;
  for (const r of proxy.routes) console.log(`  ✓ open ${origin}${r.prefix}  ->  in-VM :${r.backendPort}`);
} else {
  for (const u of urls) console.log(`  ✓ open ${u.url}  ->  in-VM :${u.backendPort}`);
}
console.log('');

process.on('SIGINT', async () => { await proxy.close(); process.exit(0); });
