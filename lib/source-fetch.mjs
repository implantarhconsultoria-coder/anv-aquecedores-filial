import dns from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { publicURL } from './product-evidence.mjs';
export function isPublicAddress(ip) {
  if(isIP(ip)===4) {
    const [a,b]=ip.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0))||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19)));
  }
  if(isIP(ip)===6) return /^2[0-9a-f]{3}:/i.test(ip)&&!/^2001:(db8|0|2):/i.test(ip);
  return false;
}
async function request(url,timeout) {
  const u=new URL(url);
  const addresses=await dns.lookup(u.hostname,{all:true});
  if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)))throw new Error('source_private_address');
  const pinned=addresses[0];
  return await new Promise((resolve,reject)=>{
    const req=https.get(u,{headers:{'User-Agent':'ANV-ProductResearch/1.0','Accept':'text/html,application/xhtml+xml'},lookup:(_host,_opts,cb)=>cb(null,pinned.address,pinned.family)},res=>{
      if([301,302,303,307,308].includes(res.statusCode)){res.resume();try{resolve({redirect:new URL(res.headers.location||'',url).href});}catch{reject(new Error('source_redirect_invalid'));}return;}
      if(res.statusCode!==200){res.resume();reject(new Error('source_http_error'));return;}
      if(!/text\/html|application\/xhtml\+xml/i.test(res.headers['content-type']||'')){res.resume();reject(new Error('source_not_html'));return;}
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>1500000){res.destroy(new Error('source_too_large'));return;}chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>resolve({html:Buffer.concat(chunks).toString('utf8'),url}));
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('source_timeout')));req.on('error',reject);
  });
}
export async function fetchSource(raw) {
  let url=publicURL(raw);if(!url)throw new Error('source_url_invalid');
  const deadline=Date.now()+10000;
  for(let i=0;i<4;i++) {if(Date.now()>=deadline)throw new Error('source_timeout');const r=await request(url,Math.min(7000,deadline-Date.now()));if(!r.redirect)return r;url=publicURL(r.redirect);if(!url)throw new Error('source_redirect_invalid');}
  throw new Error('source_redirect_limit');
}
export function pageEvidence(html,url) {
  const decode=s=>s.replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Math.min(Number(n),0x10ffff)));
  const jsonld=[...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).join('\n');
  const visible=decode(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();
  const title=decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||new URL(url).hostname).trim().slice(0,300);
  const og=[...html.matchAll(/<meta\b[^>]*>/gi)].find(m=>/\b(?:property|name)=["']og:image["']/i.test(m[0]));
  let image=og?.[0].match(/\bcontent=["']([^"']+)["']/i)?.[1];
  if(!image) {
    try {
      const find=node=>{if(Array.isArray(node))for(const x of node){const v=find(x);if(v)return v;}else if(node&&typeof node==='object'){if([].concat(node['@type']||[]).includes('Product')){const v=node.image;return typeof v==='string'?v:Array.isArray(v)?v[0]:v?.url;}return find(node['@graph']);}return null;};
      for(const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){image=find(JSON.parse(m[1]));if(image)break;}
    }catch{}
  }
  try{image=image?publicURL(new URL(decode(image),url).href):null;}catch{image=null;}
  return {text:(visible+'\n'+jsonld).slice(0,65000),title,image_url:image};
}
