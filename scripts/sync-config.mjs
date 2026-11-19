// Rewrites window.APP_CONFIG in index.html from deployments/<chainId>.json and abi/*.json,
// and the CONTAINER var of the signer Worker. Run after every deployment:
//   node scripts/sync-config.mjs            (defaults to 196)
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const chainId = process.argv[2] || '196';
const dep = JSON.parse(readFileSync(new URL(`deployments/${chainId}.json`, root), 'utf8'));
const abi = (name) => JSON.parse(readFileSync(new URL(`abi/${name}.json`, root), 'utf8'));
const addr = (a) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(a))) throw new Error(`bad address in deployments: ${a}`);
  return a;
};

const config = {
  chainId: Number(dep.chainId),
  contracts: {
    AgentContainer: { address: addr(dep.AgentContainer), abi: abi('AgentContainer') },
    PolicyCircuit: { address: addr(dep.PolicyCircuit), abi: abi('PolicyCircuit') },
  },
  tapeout: dep.tapeout || null,
};

const htmlUrl = new URL('index.html', root);
const html = readFileSync(htmlUrl, 'utf8');
const start = html.indexOf('window.APP_CONFIG = {');
const end = html.indexOf('};\n</script>', start);
if (start < 0 || end < 0) throw new Error('APP_CONFIG block not found in index.html');
const block = `window.APP_CONFIG = ${JSON.stringify(config, null, 2)};`;
writeFileSync(htmlUrl, html.slice(0, start) + block + html.slice(end + 2));

const tomlUrl = new URL('signer/wrangler.toml', root);
const toml = readFileSync(tomlUrl, 'utf8').replace(/^CONTAINER = ".*"$/m, `CONTAINER = "${dep.AgentContainer.toLowerCase()}"`);
writeFileSync(tomlUrl, toml);

console.log(`index.html + signer/wrangler.toml now point at chain ${config.chainId}:`);
console.log(`  AgentContainer ${dep.AgentContainer}\n  PolicyCircuit  ${dep.PolicyCircuit}`);
