import { clean0x, utf8, bytesToHex, hexToBytes } from './core.js';

/* Self-contained Keccak and ABI codec for browser contract calls. */
var MASK64 = (1n<<64n)-1n;
var RC = [0x0000000000000001n,0x0000000000008082n,0x800000000000808an,0x8000000080008000n,
          0x000000000000808bn,0x0000000080000001n,0x8000000080008081n,0x8000000000008009n,
          0x000000000000008an,0x0000000000000088n,0x0000000080008009n,0x000000008000000an,
          0x000000008000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,
          0x8000000000008002n,0x8000000000000080n,0x000000000000800an,0x800000008000000an,
          0x8000000080008081n,0x8000000000008080n,0x0000000080000001n,0x8000000080008008n];
var RHO = [0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];
function rotl(v,n){ n=BigInt(n%64); if(n===0n) return v & MASK64; return ((v<<n)|(v>>(64n-n))) & MASK64; }
function keccakF(st){
  for(var round=0; round<24; round++){
    var C=[],D=[],x,y;
    for(x=0;x<5;x++) C[x] = st[x]^st[x+5]^st[x+10]^st[x+15]^st[x+20];
    for(x=0;x<5;x++) D[x] = C[(x+4)%5] ^ rotl(C[(x+1)%5],1);
    for(x=0;x<5;x++) for(y=0;y<5;y++) st[x+5*y] ^= D[x];
    var B = new Array(25).fill(0n);
    for(x=0;x<5;x++) for(y=0;y<5;y++){ B[y + 5*((2*x+3*y)%5)] = rotl(st[x+5*y], RHO[x+5*y]); }
    for(x=0;x<5;x++) for(y=0;y<5;y++){
      st[x+5*y] = B[x+5*y] ^ ((~B[((x+1)%5)+5*y] & MASK64) & B[((x+2)%5)+5*y]);
    }
    st[0] ^= RC[round];
  }
}
function keccak256(input){
  var bytes = (typeof input==='string') ? utf8(input) : input;
  var rate = 136;
  var padLen = rate - (bytes.length % rate);
  var padded = new Uint8Array(bytes.length + padLen);
  padded.set(bytes,0);
  padded[bytes.length] ^= 0x01;
  padded[padded.length-1] ^= 0x80;
  var st = new Array(25).fill(0n);
  for(var off=0; off<padded.length; off+=rate){
    for(var i=0;i<rate/8;i++){
      var lane=0n;
      for(var j=7;j>=0;j--) lane = (lane<<8n) | BigInt(padded[off+i*8+j]);
      st[i] ^= lane;
    }
    keccakF(st);
  }
  var out='';
  for(var k=0;k<4;k++) out += st[k].toString(16).padStart(16,'0').match(/../g).reverse().join('');
  return out;
}
var ABI_OK = (function(){
  try{ return keccak256('transfer(address,uint256)').slice(0,8) === 'a9059cbb'; }
  catch(e){ return false; }
})();

/* --- ABI encoding --- */
function word(v){
  var b; try{ b = (typeof v==='bigint') ? v : BigInt(v); }catch(e){ throw new Error('Not an integer: '+v); }
  if(b<0n) b = BigInt.asUintN(256,b);
  return b.toString(16).padStart(64,'0');
}
function isDyn(t){ if(t.endsWith(']')) return true; return t==='string'||t==='bytes'; }
function padRight(hex){ var r = hex.length % 64; return r===0 ? hex : hex + '0'.repeat(64-r); }
function encType(type, value){
  if(type.endsWith(']')){
    var i = type.lastIndexOf('['); var inner = type.slice(0,i); var lenStr = type.slice(i+1,-1);
    var arr = Array.isArray(value) ? value : (value===undefined||value===null?[]:[value]);
    var items = arr.map(function(v){ return encType(inner,v); });
    var dyn = isDyn(inner);
    if(lenStr!==''){
      var n = parseInt(lenStr,10);
      if(!dyn){
        var s=''; for(var a=0;a<n;a++) s += items[a] ? items[a].data : word(0);
        return {dyn:false, data:s};
      }
      var off0 = n*32, headF='', tailF='';
      for(var b2=0;b2<n;b2++){ var it = items[b2] || {data:word(0)}; headF += word(off0); tailF += it.data; off0 += it.data.length/2; }
      return {dyn:true, data:headF+tailF};
    }
    if(!dyn){
      var out = word(arr.length);
      for(var c=0;c<items.length;c++) out += items[c].data;
      return {dyn:false, data:out};
    }
    var off = items.length*32, head='', tail='';
    for(var d=0; d<items.length; d++){ head += word(off); tail += items[d].data; off += items[d].data.length/2; }
    return {dyn:true, data: word(arr.length)+head+tail};
  }
  if(type==='string'){
    var sb = utf8(String(value===undefined?'':value));
    return {dyn:true, data: word(sb.length) + padRight(bytesToHex(sb))};
  }
  if(type==='bytes'){
    var bb = value ? hexToBytes(value) : new Uint8Array(0);
    return {dyn:true, data: word(bb.length) + padRight(bytesToHex(bb))};
  }
  if(/^bytes\d+$/.test(type)){
    var nb = parseInt(type.slice(5),10);
    var hb = clean0x(value||''); if(hb.length>nb*2) throw new Error('bytes'+nb+' too long');
    return {dyn:false, data:(hb + '0'.repeat(nb*2-hb.length)).padEnd(64,'0')};
  }
  if(type==='address'){
    var a = String(value||'').replace(/^0x/,'').toLowerCase();
    if(!/^[0-9a-f]{40}$/.test(a)) throw new Error('Invalid address: '+value);
    return {dyn:false, data: a.padStart(64,'0')};
  }
  if(type==='bool') return {dyn:false, data: word(value?1n:0n)};
  if(/^u?int\d*$/.test(type)){
    var bits = parseInt(type.replace(/^u?int/,'')||'256',10);
    var nv = (typeof value==='bigint') ? value : BigInt(String(value===undefined?'0':value).trim());
    return {dyn:false, data: word(BigInt.asUintN(bits, nv))};
  }
  throw new Error('Unsupported ABI type: '+type);
}
function encodeCall(item, args){
  var types = item.inputs.map(function(i){ return i.type; });
  var sig = item.name+'('+types.join(',')+')';
  var sel = keccak256(sig).slice(0,8);
  var body='';
  if(types.length){
    var enc = types.map(function(t,i){ return encType(t, args[i]); });
    var head=[], tail=[], off = types.length*32;
    enc.forEach(function(e){
      if(e.dyn){ head.push(word(off)); tail.push(e.data); off += e.data.length/2; }
      else head.push(e.data);
    });
    body = head.join('')+tail.join('');
  }
  return {data:'0x'+sel+body, signature:sig, selector:'0x'+sel};
}
function decType(type, data, at){
  function rd(o){ return data.slice(o, o+64); }
  if(type.endsWith(']')){
    var i = type.lastIndexOf('['); var inner = type.slice(0,i); var lenStr = type.slice(i+1,-1);
    var n, base;
    if(lenStr===''){ var lw = rd(at); n = lw.length>=64 ? Number(BigInt('0x'+lw)) : 0; base = at+64; }
    else { n = parseInt(lenStr,10); base = at; }
    var dyn = isDyn(inner), out=[];
    for(var k=0;k<n;k++){
      if(dyn){ var rel = Number(BigInt('0x'+rd(base+k*64))); out.push(decType(inner, data, base+rel*2)); }
      else out.push(decType(inner, data, base+k*64));
    }
    return out;
  }
  if(type==='address') return '0x'+rd(at).slice(24).toLowerCase();
  if(type==='bool') return BigInt('0x'+(rd(at)||'0')) !== 0n;
  if(/^u?int\d*$/.test(type)){
    var w = rd(at)||'0'; var bits = parseInt(type.replace(/^u?int/,'')||'256',10);
    var val = BigInt('0x'+w);
    return type.charAt(0)==='i' ? BigInt.asIntN(bits,val) : val;
  }
  if(type==='string'){ var ln = Number(BigInt('0x'+(rd(at)||'0'))); var hx = data.slice(at+64, at+64+ln*2);
    try{ return decodeURIComponent(hx.replace(/../g,'%$&')); }catch(e){ return hx; } }
  if(type==='bytes'){ var lb = Number(BigInt('0x'+(rd(at)||'0'))); return '0x'+data.slice(at+64, at+64+lb*2); }
  if(/^bytes\d+$/.test(type)){ var nb = parseInt(type.slice(5),10); return '0x'+data.slice(at, at+nb*2); }
  throw new Error('Unsupported ABI type: '+type);
}
function decodeOutputs(outputs, hex){
  var data = clean0x(hex);
  if(!outputs || !outputs.length) return [];
  if(!data) return outputs.map(function(){ return null; });
  var ptr=0, out=[];
  outputs.forEach(function(o){
    var t = o.type;
    if(isDyn(t)){ var rel = Number(BigInt('0x'+(data.slice(ptr*64,ptr*64+64)||'0'))); out.push(decType(t,data,rel*2)); }
    else out.push(decType(t,data,ptr*64));
    ptr++;
  });
  return out;
}
function parseInput(type, raw){
  var t = String(type).trim();
  if(t.endsWith(']')){
    var inner = t.slice(0,t.lastIndexOf('['));
    var parts = String(raw||'').split(',').map(function(s){ return s.trim(); }).filter(function(s){ return s!==''; });
    return parts.map(function(p){ return parseInput(inner,p); });
  }
  if(t==='bool') return raw===true || raw==='true' || raw==='1';
  if(t==='address'){
    var a = String(raw||'').trim();
    if(!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error('Invalid address');
    return a;
  }
  if(/^u?int\d*$/.test(t)){ var v = String(raw||'0').trim(); return BigInt(v===''?'0':v); }
  if(t==='string') return String(raw===undefined?'':raw);
  if(t==='bytes'){ var h = String(raw||'').trim(); return h ? (h.indexOf('0x')===0?h:'0x'+h) : '0x'; }
  if(/^bytes\d+$/.test(t)){ var h2 = String(raw||'').trim(); return h2.indexOf('0x')===0?h2:'0x'+h2; }
  throw new Error('Unsupported type '+t);
}

/* =========================================================================
   3. State (persisted, restart-safe)
   ========================================================================= */

export { ABI_OK, encodeCall, decodeOutputs, parseInput, keccak256, word };
