// Evidence rules shared by search, import and tests. No AI confidence is accepted as proof.
export const IMPORT_FIELDS = ['name','brand','model','code','application','compatibility','description','material','voltage','color','technical_details','category','gtin','dimensions','weight','references'];
export const SOURCE_PRIORITY = {manufacturer:0,official_brand:1,authorized_distributor:2,authorized_service:3,technical_catalog:4,specialist_store:5,marketplace:6,other:7};
export function cleanText(value, limit=4000) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim().slice(0,limit) : '';
}
export function normalize(value) { return cleanText(value).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]/g,''); }
export function parseModelJSON(envelope) {
  if (envelope?.status === 'incomplete' || envelope?.error) throw new Error('model_incomplete');
  let content = envelope?.output_text;
  if (!content) content = (envelope?.output || []).filter(x=>x.type==='message').flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text||'').join('');
  if (!content) {
    const c=envelope?.choices?.[0];
    if(c?.finish_reason==='length') throw new Error('model_incomplete');
    content=typeof c?.message?.content==='string'?c.message.content:(c?.message?.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('');
  }
  if (!content) throw new Error('empty_model_response');
  const raw=content.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  const result=JSON.parse(raw);
  if (!result || typeof result!=='object' || Array.isArray(result)) throw new Error('model_invalid_json');
  return result;
}
export function publicURL(value) {
  try {
    const u=new URL(value);
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.hostname.includes(':')||/^\d+(\.\d+){3}$/.test(u.hostname)) return null;
    if(!u.hostname.includes('.')||/\.(local|localhost|internal|test|invalid)$/i.test(u.hostname)) return null;
    u.hash=''; return u.href;
  } catch {return null;}
}
export function collectSearchSources(envelope) {
  const sources=new Map();
  const add=(x)=>{const url=publicURL(x?.url);if(url)sources.set(url,{url,title:cleanText(x.title,300)});};
  for(const item of envelope?.output||[]) {
    if(item.type==='web_search_call') for(const s of item.action?.sources||[]) add(s);
    if(item.type==='message') for(const c of item.content||[]) for(const a of c.annotations||[]) if(a.type==='url_citation') add(a);
  }
  return [...sources.values()];
}
export function validateFields(fields, pageText) {
  const verified={}; const matched={};
  const hay=cleanText(pageText,120000).replace(/\s+/g,' ');
  for(const key of IMPORT_FIELDS) {
    const value=cleanText(fields?.[key]?.value);
    const quote=cleanText(fields?.[key]?.quote,6000).replace(/\s+/g,' ');
    // A literal quote must exist in the fetched source and explicitly contain the value.
    if(value && quote.length>=value.length && hay.includes(quote) && quote.toLowerCase().includes(value.replace(/\s+/g,' ').toLowerCase())) {
      verified[key]=value; matched[key]={value,quote};
    }
  }
  return {fields:verified,matched_fields:matched};
}
export function scoreCandidate(hints, candidate) {
  const f=candidate.fields||{};
  const codes=[...(hints.codes||[]),hints.part_number].filter(Boolean).map(normalize).filter(x=>x.length>=4);
  const exactCode=!!normalize(f.code)&&codes.includes(normalize(f.code));
  const brand=!!normalize(hints.brand)&&normalize(hints.brand)===normalize(f.brand);
  const model=!!normalize(hints.model)&&normalize(hints.model)===normalize(f.model);
  const compared=!!candidate.image_url && candidate.visual?.compared===true;
  const rawVisual=Number(candidate.visual?.similarity);
  const visual=compared&&Number.isFinite(rawVisual)?Math.max(0,Math.min(1,rawVisual)):0;
  const conflict=!!candidate.visual?.conflicts?.length || (hints.brand&&f.brand&&!brand) || (hints.model&&f.model&&!model) || (codes.length&&f.code&&!exactCode);
  // Heuristic evidence score, not a probability. Appearance alone never reaches 80%.
  let score=exactCode?80:0;
  if(brand)score+=8;
  if(model)score+=4;
  score+=Math.round(visual*8);
  if(!exactCode) score=Math.min(79,(brand?25:0)+(model?30:0)+Math.round(visual*24));
  if(!compared || visual<0.8)score=Math.min(score,94);
  if(conflict)score=Math.min(score,59);
  if(!f.name)score=0;
  return {score:Math.min(100,score),evidence:{exact_code:exactCode,brand_match:brand,model_match:model,image_compared:compared,visual_similarity:visual,conflict:!!conflict}};
}
export function rankCandidates(hints,candidates) {
  return candidates.map(c=>({...c,...scoreCandidate(hints,c)})).sort((a,b)=>b.score-a.score||(SOURCE_PRIORITY[a.source_type]??7)-(SOURCE_PRIORITY[b.source_type]??7)).slice(0,3);
}
