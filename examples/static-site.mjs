// Example: serve a static-site (or any plain HTTP app) MicroVM in the browser
// using a token you already have. No AWS calls made by the library here —
// pure transport, you supply endpoint + token.
//
//   ENDPOINT=xxxx.lambda-microvm.us-east-1.on.aws TOKEN=<jwe> node examples/static-site.mjs
import { createProxy } from '../src/index.mjs';

const endpoint = process.env.ENDPOINT;
const token = process.env.TOKEN;
if (!endpoint || !token) { console.error('set ENDPOINT and TOKEN'); process.exit(1); }

const proxy = createProxy({ endpoint, token, port: 3000, onLog: console.log.bind(null, '[log]') });
await proxy.listen();
console.log('\n  ✓ open http://localhost:3000\n');
