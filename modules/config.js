/* Validated static deployment configuration. */
var CFG = (typeof window.APP_CONFIG === 'object' && window.APP_CONFIG) ? window.APP_CONFIG : null;
/* Only well-formed entries from window.APP_CONFIG are trusted: an injected or stale
   address is dropped instead of being used to build transactions, and the page says
   so in the activity feed rather than pretending everything is fine. */
var CONFIG_WARNINGS = [];
var CONTRACTS = (function(){
  var out = {}, src = (CFG && CFG.contracts) || {};
  Object.keys(src).forEach(function(name){
    var entry = src[name] || {};
    var addr = String(entry.address || '');
    if(!/^0x[0-9a-fA-F]{40}$/.test(addr)){
      CONFIG_WARNINGS.push(name+': address "'+addr+'" is not a valid 0x address and was ignored');
      return;
    }
    out[name] = { address: addr, abi: Array.isArray(entry.abi) ? entry.abi : [] };
  });
  return out;
})();
var CONTRACT_NAMES = Object.keys(CONTRACTS);
var LIVE = CONTRACT_NAMES.length > 0;
var API = (CFG && CFG.api) ? String(CFG.api).replace(/\/+$/,'') : null;
var CHAIN_ID = (CFG && CFG.chainId) ? Number(CFG.chainId) : 196;
var CHAINS = {
  196: {name:'X Layer Mainnet', sym:'OKB', scan:'https://www.oklink.com/xlayer'},
  1952: {name:'X Layer Testnet', sym:'OKB', scan:'https://www.oklink.com/xlayer-test'}
};
var CHAIN = CHAINS[CHAIN_ID] || {name:'Chain '+CHAIN_ID, sym:'OKB', scan:''};
export { CFG, CONFIG_WARNINGS, CONTRACTS, CONTRACT_NAMES, LIVE, API, CHAIN_ID, CHAINS, CHAIN };
