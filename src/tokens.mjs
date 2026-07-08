// Token management for MicroVM endpoints.
//
// MicroVM auth tokens (JWE) are minted with create-microvm-auth-token and have a
// max 60-minute TTL. A long-lived browser session outlives a single token, so we
// cache + auto-refresh transparently.
//
// Three ways to supply tokens, in order of decoupling:
//   1. token:    "<jwe>"                       — static, you manage refresh
//   2. getToken: async () => "<jwe>"           — you mint however you like (BYO)
//   3. mint:     { microvmId, region, ... }    — we self-mint via the aws CLI
//
// Options 1 & 2 keep this library pure transport (no AWS dependency at all).
// Option 3 shells out to `aws lambda-microvms` (no SDK dependency either).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const DEFAULT_TTL_MIN = 60;            // platform max
const REFRESH_BEFORE_MS = 10 * 60_000; // refresh when <10 min remains
const ALL_PORTS = '[{"allPorts":{}}]';

// Build the --allowed-ports JSON for create-microvm-auth-token. Pass an array
// of in-VM ports for a least-privilege token scoped to just those apps, or
// 'all' (or a falsy value) for the platform's all-ports token. A string that
// already looks like JSON is passed through unchanged.
function allowedPortsJson(ports) {
  if (!ports || ports === 'all') return ALL_PORTS;
  if (typeof ports === 'string' && ports.trim().startsWith('[')) return ports;
  const list = (Array.isArray(ports) ? ports : String(ports).split(','))
    .map((p) => Number(p))
    .filter((p) => Number.isInteger(p) && p > 0);
  if (!list.length) return ALL_PORTS;
  const uniq = [...new Set(list)];
  return JSON.stringify(uniq.map((port) => ({ port })));
}

// Mint a token by shelling out to the AWS CLI (no SDK needed).
// `allowedPorts` may be an array of ports, a comma string, 'all', or raw JSON.
async function mintViaCli({ microvmId, region, awsCli = 'aws', ttlMinutes = DEFAULT_TTL_MIN, allowedPorts }) {
  if (!microvmId) throw new Error('mint config requires microvmId');
  const args = ['lambda-microvms', 'create-microvm-auth-token',
    '--microvm-identifier', microvmId,
    '--expiration-in-minutes', String(ttlMinutes),
    '--allowed-ports', allowedPortsJson(allowedPorts),
    '--query', 'authToken."X-aws-proxy-auth"', '--output', 'text'];
  if (region) args.push('--region', region);
  const { stdout } = await exec(awsCli, args);
  return stdout.trim();
}

/**
 * Build a getToken() function from whichever option the caller provided.
 * Returns an async () => string that caches and refreshes as needed.
 *
 * @param {object} opts
 * @param {string} [opts.token]                static token
 * @param {() => (string|Promise<string>)} [opts.getToken]  custom minting
 * @param {object} [opts.mint]                 self-mint config (microvmId, region, awsCli, ttlMinutes)
 * @param {(level,msg)=>void} [opts.onLog]
 */
export function createTokenProvider(opts = {}) {
  const log = opts.onLog || (() => {});

  // 1. static token — no refresh. refresh() is a no-op that returns the same
  // value, so a caller's "re-mint on 403 then retry" logic naturally skips the
  // retry (the token didn't change).
  if (opts.token) {
    const t = String(opts.token).trim();
    const getToken = async () => t;
    getToken.refresh = async () => t;
    return getToken;
  }

  // pick the underlying minter for 2 (custom) or 3 (self-mint)
  let minter;
  if (typeof opts.getToken === 'function') {
    minter = async () => String(await opts.getToken()).trim();
  } else if (opts.mint) {
    minter = () => mintViaCli(opts.mint);
  } else {
    throw new Error('createTokenProvider: provide one of { token, getToken, mint }');
  }

  // cache + refresh wrapper. TTL is known only for self-mint; for custom
  // getToken we refresh on the same cadence (assume the platform 60-min max).
  let cached = null;
  let mintedAt = 0;
  let inflight = null;
  const ttlMs = ((opts.mint?.ttlMinutes ?? DEFAULT_TTL_MIN) * 60_000);

  async function refresh() {
    if (inflight) return inflight;       // collapse concurrent refreshes
    inflight = (async () => {
      const t = await minter();
      cached = t; mintedAt = Date.now();
      log('info', 'token refreshed');
      return t;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  async function getToken() {
    const age = Date.now() - mintedAt;
    if (!cached || age > ttlMs - REFRESH_BEFORE_MS) return refresh();
    return cached;
  }

  // Force a re-mint regardless of TTL. Used to react to an upstream 403 (the
  // token was rejected before its expected expiry — e.g. the VM slept past the
  // token's life, or it was revoked). Shares the inflight collapse so a burst of
  // 403s triggers a single re-mint.
  getToken.refresh = refresh;
  return getToken;
}

export { mintViaCli, allowedPortsJson };
