// TapeGuard signer: a tiny Cloudflare Worker that holds the relayer key.
//
//   GET  /health -> { ok, address }
//   POST /sign   { type, transaction } -> { address, rawTransaction }
//
// Both need `Authorization: Bearer <SIGNER_TOKEN>`. The key never leaves this Worker,
// and it only signs AgentContainer.execute(...) on the configured chain (policy.js).
// Secrets:  RELAYER_PRIVATE_KEY, SIGNER_TOKEN      Vars: CONTAINER, CHAIN_ID
import { privateKeyToAccount } from 'viem/accounts';
import { readConfig, validateRequest, tokenMatches } from './policy.js';

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

function account(env) {
  const key = String(env.RELAYER_PRIVATE_KEY || '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('RELAYER_PRIVATE_KEY is not configured');
  return privateKeyToAccount(key);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (!tokenMatches(request.headers.get('authorization'), env.SIGNER_TOKEN)) {
      return json(401, { ok: false, error: 'unauthorised' });
    }
    let signer;
    let cfg;
    try {
      signer = account(env);
      cfg = readConfig(env);
    } catch (error) {
      return json(500, { ok: false, error: error.message });
    }

    if (request.method === 'GET' && pathname === '/health') {
      return json(200, { ok: true, address: signer.address.toLowerCase(), container: cfg.container, chainId: Number(cfg.chainId) });
    }

    if (request.method === 'POST' && pathname === '/sign') {
      let tx;
      try {
        tx = validateRequest(await request.json(), cfg);
      } catch (error) {
        console.warn('refused to sign:', error.message);
        return json(400, { ok: false, error: error.message });
      }
      const rawTransaction = await signer.signTransaction(tx);
      console.log(`signed execute nonce=${tx.nonce} gas=${tx.gas}`);
      return json(200, { ok: true, address: signer.address.toLowerCase(), rawTransaction });
    }

    return json(404, { ok: false, error: 'not found' });
  },
};
