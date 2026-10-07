import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { getVercelOidcToken } from '@vercel/oidc';

const PROJECT_ID = 'prj_L8E2o1UByRs55MjwYUsLcII6kI6F';
const TEAM_ID = 'team_EF2ynCny10Wt5LjD5O3f2FhM';
const VISION_MODEL = 'openai/gpt-5-mini';
const EXTRACT_MODEL = 'openai/gpt-5-mini';
const WEB_MODELS = ['anthropic/claude-sonnet-5', 'anthropic/claude-opus-5'];
const AI_GATEWAY = 'https://ai-gateway.vercel.sh';
const CACHE_DAYS = 30;

const VISION_PROMPT = `Você é a etapa de IDENTIFICAÇÃO BÁSICA da ANV Filial Digital.
Analise a imagem SOMENTE para obter pistas verificáveis que ajudem a localizar o produto exato na internet.
NÃO gere anúncio, aplicação, compatibilidade, descrição comercial, categoria final nem especificações que não estejam literalmente visíveis.
NÃO adivinhe marca/modelo/código por aparência.
Retorne EXCLUSIVAMENTE JSON válido:
{
  "product_type": null,
  "brand": null,
  "name_hint": null,
  "code": null,
  "sku": null,
  "part_number": null,
  "reference": null,
  "model": null,
  "ean": null,
  "manufacturer": null,
  "line": null,
  "measurements": [],
  "visible_text": [],
  "visual_features": [],
  "confidence": 0.0,
  "warnings": []
}
Regras:
- Copie códigos/EAN/textos somente quando legíveis.
- EAN deve conter apenas dígitos e ter comprimento plausível (8, 12, 13 ou 14); caso contrário, null.
- code/sku/part_number/reference/model só quando houver texto inequívoco.
- visual_features pode conter cor, formato, número de conexões e elementos realmente visíveis, mas não interpretação técnica especulativa.
- Se nada for legível, mantenha campos null/vazios e reduza confidence.
- Nunca invente informação ausente.`;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readSession(token) {
  const secret = process.env.APP_SESSION_SECRET || '';
  if (!secret || !token) return null;
  try {
    const [encoded, signature] = token.split('.', 2);
    if (!encoded || !signature) return null;
    const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (Number(payload.exp || 0) < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function isOwnerSession(user) {
  const email = String(user?.email || '').toLowerCase().trim();
  const role = String(user?.role || '').toLowerCase();
  const owner = String(process.env.ANV_LOGIN_EMAIL || '').toLowerCase().trim();
  return !!email && email === owner && ['owner', 'admin'].includes(role);
}

function sbConfig() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('database_unavailable');
  return { url, key };
}

async function sbGet(table, params = {}) {
  const { url, key } = sbConfig();
  const u = new URL(`${url}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  const r = await fetch(u, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error('database_unavailable');
  return await r.json();
}

async function ensureWriteAccess(user) {
  if (isOwnerSession(user)) return true;
  const email = String(user?.email || '').toLowerCase().trim();
  const rows = await sbGet('anv_access_users', { select: 'access_status,active', email: `eq.${email}`, limit: '1' });
  const record = rows?.[0];
  if (!record || !record.active) return false;
  return String(record.access_status || 'AGUARDANDO_LIBERACAO') === 'LIBERADO';
}

async function gatewayToken() {
  if (process.env.AI_GATEWAY_API_KEY) return process.env.AI_GATEWAY_API_KEY;
  return await getVercelOidcToken({ project: PROJECT_ID, team: TEAM_ID, expirationBufferMs: 60_000 });
}

function clamp(n, a = 0, b = 1) {
  n = Number(n);
  return Number.isFinite(n) ? Math.max(a, Math.min(b, n)) : a;
}

function cleanText(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanArray(value, maxItems = 20, itemMax = 300) {
  if (!Array.isArray(value)) return [];
  return value.map(v => cleanText(v, itemMax)).filter(Boolean).slice(0, maxItems);
}

function norm(value) {
  return cleanText(value, 250).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function compact(value) {
  return cleanText(value, 250).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function digits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function normalizeClues(raw = {}) {
  const ean = digits(raw.ean);
  return {
    product_type: cleanText(raw.product_type, 120) || null,
    brand: cleanText(raw.brand, 120) || null,
    name_hint: cleanText(raw.name_hint, 180) || null,
    code: cleanText(raw.code, 120) || null,
    sku: cleanText(raw.sku, 120) || null,
    part_number: cleanText(raw.part_number, 120) || null,
    reference: cleanText(raw.reference, 120) || null,
    model: cleanText(raw.model, 120) || null,
    ean: [8, 12, 13, 14].includes(ean.length) ? ean : null,
    manufacturer: cleanText(raw.manufacturer, 120) || null,
    line: cleanText(raw.line, 120) || null,
    measurements: cleanArray(raw.measurements, 12, 100),
    visible_text: cleanArray(raw.visible_text, 30, 150),
    visual_features: cleanArray(raw.visual_features, 20, 180),
    confidence: clamp(raw.confidence),
    warnings: cleanArray(raw.warnings, 12, 220)
  };
}

function identifiersFrom(clues = {}) {
  return {
    ean: clues.ean || null,
    part_number: clues.part_number || null,
    code: clues.code || null,
    sku: clues.sku || null,
    reference: clues.reference || null,
    brand: clues.brand || null,
    model: clues.model || null,
    manufacturer: clues.manufacturer || null,
    line: clues.line || null,
    name_hint: clues.name_hint || null,
    measurements: clues.measurements || [],
    visible_text: clues.visible_text || [],
    visual_features: clues.visual_features || []
  };
}

function extractJson(text) {
  const s = String(text || '').trim();
  const tries = [s, s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')];
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) tries.push(s.slice(first, last + 1));
  for (const t of tries) {
    try { return JSON.parse(t); } catch {}
  }
  throw new Error('model_invalid_json');
}

async function gatewayChatJson(model, messages, maxTokens = 1800) {
  const token = await gatewayToken();
  if (!token) throw new Error('gateway_token_unavailable');
  const response = await fetch(`${AI_GATEWAY}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, response_format: { type: 'json_object' }, max_completion_tokens: maxTokens })
  });
  const raw = await response.text();
  if (!response.ok) {
    const e = new Error('gateway_error'); e.status = response.status; e.detail = raw.slice(0, 1200); throw e;
  }
  const envelope = extractJson(raw);
  const content = envelope?.choices?.[0]?.message?.content;
  if (!content) throw new Error('empty_model_response');
  return extractJson(content);
}

async function analyzeImageClues(imageDataUrl) {
  return normalizeClues(await gatewayChatJson(VISION_MODEL, [{ role: 'user', content: [
    { type: 'text', text: VISION_PROMPT },
    { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } }
  ] }], 1200));
}

function buildSearchQueries(clues) {
  const q = [];
  const add = (...parts) => {
    const value = parts.flat().filter(Boolean).map(x => cleanText(x, 120)).filter(Boolean).join(' ').trim();
    if (value && !q.some(x => norm(x) === norm(value))) q.push(value);
  };
  if (clues.ean) add(`\"${clues.ean}\"`);
  if (clues.part_number) add(clues.brand, `\"${clues.part_number}\"`);
  if (clues.code) add(clues.brand, `\"${clues.code}\"`);
  if (clues.sku) add(clues.brand, `\"${clues.sku}\"`);
  if (clues.brand && clues.model) add(clues.brand, `\"${clues.model}\"`);
  if (clues.brand && clues.name_hint) add(clues.brand, clues.name_hint, clues.measurements?.[0]);
  add(clues.manufacturer, clues.name_hint, ...(clues.visible_text || []).slice(0, 4));
  add(clues.brand, clues.name_hint, ...(clues.visual_features || []).slice(0, 3));
  return q.filter(Boolean).slice(0, 8);
}

function sourceTypePriority(type) {
  const t = norm(type).replace(/ /g, '_');
  return ({ manufacturer: 20, fabricante: 20, official_catalog: 18, catalogo_oficial: 18, authorized_distributor: 15,
    distribuidor_oficial: 15, technical_reseller: 12, revendedor_tecnico: 12, specialized_store: 10,
    loja_especializada: 10, ecommerce: 8, marketplace: 4, other: 2, outra: 2 })[t] || 2;
}

function candidateField(c, ...names) {
  for (const name of names) if (cleanText(c?.[name], 250)) return cleanText(c[name], 250);
  return '';
}

function exactId(a, b) {
  const aa = compact(a), bb = compact(b);
  return !!aa && !!bb && aa === bb;
}

function scoreCandidate(c, clues) {
  let score = sourceTypePriority(c.source_type);
  const evidence = [];
  const conflicts = [];
  const cEan = digits(candidateField(c, 'ean', 'gtin'));
  const cPart = candidateField(c, 'part_number', 'mpn', 'code');
  const cCode = candidateField(c, 'code', 'sku', 'part_number');
  const cBrand = candidateField(c, 'brand', 'manufacturer');
  const cModel = candidateField(c, 'model');

  if (clues.ean && cEan) {
    if (clues.ean === cEan) { score += 100; evidence.push(`EAN exato: ${clues.ean}`); }
    else { score -= 140; conflicts.push(`EAN divergente: ${cEan}`); }
  }
  const strongClue = clues.part_number || clues.code || clues.sku || clues.reference;
  if (strongClue && (cPart || cCode)) {
    if (exactId(strongClue, cPart) || exactId(strongClue, cCode)) { score += 80; evidence.push(`Código/part number exato: ${strongClue}`); }
    else if (compact(strongClue).length >= 4) { score -= 75; conflicts.push(`Código divergente: ${cPart || cCode}`); }
  }
  if (clues.brand && cBrand) {
    if (norm(clues.brand) === norm(cBrand) || norm(cBrand).includes(norm(clues.brand)) || norm(clues.brand).includes(norm(cBrand))) { score += 20; evidence.push(`Marca coerente: ${cBrand}`); }
    else { score -= 55; conflicts.push(`Marca divergente: ${cBrand}`); }
  }
  if (clues.model && cModel) {
    if (exactId(clues.model, cModel) || norm(clues.model) === norm(cModel)) { score += 35; evidence.push(`Modelo exato: ${cModel}`); }
    else { score -= 60; conflicts.push(`Modelo divergente: ${cModel}`); }
  }
  const blob = norm([c.title, c.name, c.description, JSON.stringify(c.specifications || {})].join(' '));
  if (clues.name_hint && blob.includes(norm(clues.name_hint))) { score += 10; evidence.push('Nome/tipo coerente'); }
  for (const m of clues.measurements || []) {
    if (norm(m) && blob.includes(norm(m))) { score += 8; evidence.push(`Medida coerente: ${m}`); }
  }
  for (const text of (clues.visible_text || []).slice(0, 5)) {
    const n = norm(text);
    if (n.length >= 3 && blob.includes(n)) score += 3;
  }
  return { score, evidence, conflicts };
}

function cleanCandidate(c) {
  let url = cleanText(c?.url, 1200);
  try { url = new URL(url).toString(); } catch { url = ''; }
  return {
    url,
    domain: cleanText(c?.domain, 180) || (() => { try { return new URL(url).hostname; } catch { return ''; } })(),
    title: cleanText(c?.title, 300),
    name: cleanText(c?.name, 250),
    source_type: cleanText(c?.source_type, 80) || 'other',
    manufacturer: cleanText(c?.manufacturer, 160),
    brand: cleanText(c?.brand, 160),
    model: cleanText(c?.model, 160),
    code: cleanText(c?.code, 160),
    part_number: cleanText(c?.part_number || c?.mpn, 160),
    ean: digits(c?.ean || c?.gtin) || '',
    description: cleanText(c?.description, 600),
    image_url: cleanText(c?.image_url, 1200),
    specifications: c?.specifications && typeof c.specifications === 'object' ? c.specifications : {},
    evidence: cleanArray(c?.evidence, 12, 250)
  };
}

function sameIdentity(a, b) {
  if (a.ean && b.ean) return a.ean === b.ean;
  const aCode = a.part_number || a.code, bCode = b.part_number || b.code;
  if (aCode && bCode) return exactId(aCode, bCode) && (!a.brand || !b.brand || norm(a.brand) === norm(b.brand));
  return !!a.brand && !!b.brand && !!a.model && !!b.model && norm(a.brand) === norm(b.brand) && norm(a.model) === norm(b.model);
}

function chooseMatch(candidates, clues) {
  const scored = candidates.map(c => ({ ...c, ...scoreCandidate(c, clues) })).filter(c => c.url).sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top) return { status: 'PRODUTO_NAO_CONFIRMADO', match_level: 'insuficiente', confidence: 0, candidates: [] };

  const hasExactEan = clues.ean && top.ean === clues.ean;
  const strong = clues.part_number || clues.code || clues.sku || clues.reference;
  const hasExactCode = strong && (exactId(strong, top.part_number) || exactId(strong, top.code));
  const exactBrandModel = clues.brand && clues.model && top.brand && top.model && norm(clues.brand) === norm(top.brand) && norm(clues.model) === norm(top.model);
  const invalid = top.conflicts.length > 0 && !(hasExactEan || hasExactCode);

  let matchLevel = 'insuficiente';
  let confirmed = false;
  if (!invalid && (hasExactEan || hasExactCode || (exactBrandModel && top.score >= 65))) {
    matchLevel = 'forte'; confirmed = true;
  } else if (!invalid && top.score >= 45) {
    const corroborating = scored.slice(1).find(x => x.score >= 25 && sameIdentity(top, x) && x.domain !== top.domain);
    if (corroborating) { matchLevel = 'provavel'; confirmed = true; top.evidence.push(`Validação cruzada: ${corroborating.domain}`); }
  }
  const confidence = confirmed ? clamp(matchLevel === 'forte' ? 0.94 + Math.min(0.05, Math.max(0, top.score - 100) / 1000) : 0.82) : clamp(Math.max(0.15, Math.min(0.69, top.score / 100)));

  let source = top;
  if (confirmed) {
    const same = scored.filter(x => sameIdentity(top, x) && x.score >= Math.max(20, top.score - 35));
    same.sort((a, b) => sourceTypePriority(b.source_type) - sourceTypePriority(a.source_type) || b.score - a.score);
    source = same[0] || top;
    source.evidence = Array.from(new Set([...(top.evidence || []), ...(source.evidence || [])]));
  }
  return {
    status: confirmed ? 'CONFIRMADO' : 'PRODUTO_NAO_CONFIRMADO',
    match_level: matchLevel,
    confidence,
    selected: confirmed ? source : null,
    candidates: scored.slice(0, 8).map(({ score, evidence, conflicts, ...c }) => ({ ...c, score, evidence, conflicts }))
  };
}

async function webResearch(clues) {
  const queries = buildSearchQueries(clues);
  if (!queries.length) return { candidates: [], queries };
  const token = await gatewayToken();
  if (!token) throw new Error('gateway_token_unavailable');
  const prompt = `Localize na internet o produto exato a partir destas pistas de uma foto.\nPISTAS: ${JSON.stringify(identifiersFrom(clues))}\nCONSULTAS PRIORITÁRIAS: ${JSON.stringify(queries)}\n\nUse busca web real. Pesquise de forma progressiva e ampla, não apenas Mercado Livre. Priorize fabricante, catálogo oficial, distribuidor oficial, revendedor técnico e loja especializada. Não aceite similaridade visual isolada. Código/EAN/modelo/medida divergente deve ser tratado como conflito.\nRetorne ao final SOMENTE um JSON válido neste formato:\n{\"candidates\":[{\"url\":\"https://...\",\"domain\":\"...\",\"title\":\"...\",\"name\":\"...\",\"source_type\":\"manufacturer|official_catalog|authorized_distributor|technical_reseller|specialized_store|ecommerce|marketplace|other\",\"manufacturer\":null,\"brand\":null,\"model\":null,\"code\":null,\"part_number\":null,\"ean\":null,\"description\":\"fatos curtos\",\"image_url\":null,\"specifications\":{},\"evidence\":[\"evidência objetiva\"]}]}\nInclua até 10 candidatos úteis, sem inventar URLs ou fatos.`;
  let lastError;
  for (const model of WEB_MODELS) {
    try {
      const r = await fetch(`${AI_GATEWAY}/v1/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 2600,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const raw = await r.text();
      if (!r.ok) { lastError = new Error(`web_search_${r.status}`); lastError.detail = raw.slice(0, 1200); continue; }
      const envelope = extractJson(raw);
      const text = (envelope?.content || []).filter(x => x?.type === 'text').map(x => x.text || '').join('\n');
      const parsed = extractJson(text);
      const candidates = (Array.isArray(parsed?.candidates) ? parsed.candidates : []).map(cleanCandidate).filter(x => x.url);
      return { candidates, queries, model };
    } catch (e) { lastError = e; }
  }
  throw lastError || new Error('web_search_failed');
}

function isPrivateIp(address) {
  const a = String(address || '').toLowerCase();
  if (a === '::1' || a === '0.0.0.0' || a.startsWith('127.') || a.startsWith('10.') || a.startsWith('192.168.') || a.startsWith('169.254.')) return true;
  const m = a.match(/^172\.(\d+)\./); if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80:')) return true;
  return false;
}

async function validatePublicUrl(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('unsafe_url');
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('unsafe_url');
  if (isIP(host) && isPrivateIp(host)) throw new Error('unsafe_url');
  if (!isIP(host)) {
    const addresses = await lookup(host, { all: true });
    if (!addresses.length || addresses.some(x => isPrivateIp(x.address))) throw new Error('unsafe_url');
  }
  return u;
}

async function readLimitedText(response, maxBytes = 450_000) {
  const reader = response.body?.getReader?.();
  if (!reader) return (await response.text()).slice(0, maxBytes);
  const decoder = new TextDecoder();
  let total = 0, out = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { out += decoder.decode(value.slice(0, Math.max(0, maxBytes - (total - value.byteLength))), { stream: true }); try { await reader.cancel(); } catch {} break; }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

async function safeFetchPage(url, maxRedirects = 3) {
  let current = (await validatePublicUrl(url)).toString();
  for (let i = 0; i <= maxRedirects; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let r;
    try { r = await fetch(current, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'ANVProductResearch/1.0 (+product-data-validation)', Accept: 'text/html,application/xhtml+xml' } }); }
    finally { clearTimeout(timer); }
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get('location'); if (!loc) throw new Error('redirect_without_location');
      current = (await validatePublicUrl(new URL(loc, current).toString())).toString(); continue;
    }
    if (!r.ok) throw new Error(`source_http_${r.status}`);
    const type = String(r.headers.get('content-type') || '').toLowerCase();
    if (!type.includes('text/html') && !type.includes('application/xhtml')) throw new Error('source_not_html');
    const html = await readLimitedText(r);
    return { url: current, html, contentType: type };
  }
  throw new Error('too_many_redirects');
}

function absoluteUrl(base, value) {
  try { return new URL(value, base).toString(); } catch { return ''; }
}

function decodeEntities(s) {
  return String(s || '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function extractPageEvidence(page) {
  const html = page.html || '';
  const meta = name => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
    const reverse = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i');
    return decodeEntities((html.match(re) || html.match(reverse) || [])[1] || '');
  };
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || meta('og:title'));
  const description = meta('description') || meta('og:description');
  const images = [meta('og:image'), meta('twitter:image')].filter(Boolean).map(x => absoluteUrl(page.url, x));
  const ldBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].slice(0, 12);
  for (const m of ldBlocks) {
    try {
      const data = JSON.parse(m[1]);
      const stack = Array.isArray(data) ? data : [data];
      for (const obj of stack) {
        const img = obj?.image;
        if (typeof img === 'string') images.push(absoluteUrl(page.url, img));
        else if (Array.isArray(img)) for (const x of img) if (typeof x === 'string') images.push(absoluteUrl(page.url, x));
        else if (img?.url) images.push(absoluteUrl(page.url, img.url));
      }
    } catch {}
  }
  const plain = decodeEntities(html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).slice(0, 60_000);
  return { title: cleanText(title, 350), description: cleanText(description, 1000), text: plain, image_urls: Array.from(new Set(images.filter(Boolean))).slice(0, 8) };
}

async function findUsableSource(match) {
  const candidates = [match.selected, ...(match.candidates || [])].filter(Boolean);
  const seen = new Set();
  for (const c of candidates) {
    if (!c.url || seen.has(c.url)) continue; seen.add(c.url);
    if (match.selected && c !== match.selected && !sameIdentity(match.selected, c)) continue;
    try {
      const page = await safeFetchPage(c.url);
      return { candidate: c, page, evidence: extractPageEvidence(page) };
    } catch {}
  }
  throw new Error('no_accessible_source');
}

async function extractFactsFromSource(source, clues) {
  const prompt = `Extraia somente fatos comprovados da página abaixo para o cadastro ANV. Cruze com os identificadores vistos na imagem. Se houver conflito forte, não use o dado conflitante. Não copie texto comercial longo: produza uma descrição própria, curta e factual. Nunca invente campo ausente.\nIDENTIFICADORES DA IMAGEM: ${JSON.stringify(identifiersFrom(clues))}\nURL: ${source.page.url}\nTÍTULO/META: ${JSON.stringify({ title: source.evidence.title, description: source.evidence.description })}\nCONTEÚDO VISÍVEL DA PÁGINA: ${source.evidence.text}\nRetorne SOMENTE JSON válido:\n{\"name\":null,\"brand\":null,\"manufacturer\":null,\"line\":null,\"model\":null,\"code\":null,\"sku\":null,\"part_number\":null,\"ean\":null,\"description\":null,\"measurements\":[],\"material\":null,\"application\":null,\"compatibility\":null,\"specifications\":{},\"unit\":null,\"quantity\":null,\"warranty\":null,\"technical_details\":null,\"image_urls\":[],\"category_terms\":[],\"warnings\":[]}`;
  const result = await gatewayChatJson(EXTRACT_MODEL, [{ role: 'user', content: prompt }], 2200);
  const facts = {
    name: cleanText(result.name, 250) || null,
    brand: cleanText(result.brand, 160) || null,
    manufacturer: cleanText(result.manufacturer, 160) || null,
    line: cleanText(result.line, 160) || null,
    model: cleanText(result.model, 160) || null,
    code: cleanText(result.code, 160) || null,
    sku: cleanText(result.sku, 160) || null,
    part_number: cleanText(result.part_number, 160) || null,
    ean: digits(result.ean) || null,
    description: cleanText(result.description, 1200) || null,
    measurements: cleanArray(result.measurements, 15, 120),
    material: cleanText(result.material, 200) || null,
    application: cleanText(result.application, 700) || null,
    compatibility: cleanText(result.compatibility, 700) || null,
    specifications: result.specifications && typeof result.specifications === 'object' ? result.specifications : {},
    unit: cleanText(result.unit, 80) || null,
    quantity: cleanText(result.quantity, 80) || null,
    warranty: cleanText(result.warranty, 200) || null,
    technical_details: cleanText(result.technical_details, 1500) || null,
    image_urls: Array.from(new Set([...cleanArray(result.image_urls, 10, 1200), ...(source.evidence.image_urls || []), source.candidate.image_url].filter(Boolean))).slice(0, 8),
    category_terms: cleanArray(result.category_terms, 8, 120),
    warnings: cleanArray(result.warnings, 12, 250)
  };
  return crossCheckFacts(facts, clues);
}

function crossCheckFacts(facts, clues) {
  const warnings = [...facts.warnings];
  if (clues.ean && facts.ean && clues.ean !== facts.ean) { warnings.push(`EAN da fonte (${facts.ean}) diverge da imagem (${clues.ean}); campo descartado.`); facts.ean = null; }
  const strong = clues.part_number || clues.code || clues.sku || clues.reference;
  const factCode = facts.part_number || facts.code || facts.sku;
  if (strong && factCode && !exactId(strong, factCode)) {
    warnings.push(`Código da fonte (${factCode}) diverge da imagem (${strong}); códigos da fonte descartados.`);
    facts.code = null; facts.sku = null; facts.part_number = null;
  }
  if (clues.brand && facts.brand && norm(clues.brand) !== norm(facts.brand)) { warnings.push(`Marca da fonte (${facts.brand}) diverge da imagem (${clues.brand}); marca da fonte descartada.`); facts.brand = clues.brand; }
  if (clues.model && facts.model && !exactId(clues.model, facts.model) && norm(clues.model) !== norm(facts.model)) { warnings.push(`Modelo da fonte (${facts.model}) diverge da imagem (${clues.model}); modelo da fonte descartado.`); facts.model = clues.model; }
  facts.warnings = Array.from(new Set(warnings));
  return facts;
}

async function findExisting(clues) {
  const attempts = [];
  if (clues.ean) attempts.push({ field: 'gtin', value: clues.ean });
  for (const value of [clues.part_number, clues.code, clues.sku, clues.reference]) if (cleanText(value)) attempts.push({ field: 'code', value });
  if (clues.sku) attempts.push({ field: 'sku', value: clues.sku });
  for (const a of attempts) {
    const rows = await sbGet('anv_products', { select: '*', [a.field]: `eq.${a.value}`, limit: '1' });
    if (rows?.[0]) return rows[0];
  }
  if (clues.brand && clues.model) {
    const rows = await sbGet('anv_products', { select: '*', brand: `ilike.${clues.brand}`, model: `ilike.${clues.model}`, limit: '1' });
    if (rows?.[0]) return rows[0];
  }
  return null;
}

function cacheFresh(product) {
  if (!product?.source_url || String(product.research_status || '') !== 'CONFIRMADO' || !product.researched_at) return false;
  const t = Date.parse(product.researched_at);
  return Number.isFinite(t) && Date.now() - t < CACHE_DAYS * 86400_000;
}

function responseFromCached(product, clues, imageHash) {
  const meta = product.research_meta && typeof product.research_meta === 'object' ? product.research_meta : {};
  return {
    product_type: clues.product_type || null,
    name: product.name, brand: product.brand, model: product.model, material: product.material,
    application: product.application, compatibility: product.compatibility, description: product.description,
    technical_details: product.technical_details, code: product.code, sku: product.sku, gtin: product.gtin,
    suggested_category_terms: [], visible_text: clues.visible_text, confidence: Number(product.research_confidence || 0.95),
    field_confidence: { name: 0.98, brand: 0.98, model: 0.98, material: 0.9, application: 0.9, compatibility: 0.9 },
    needs_confirmation: [], warnings: ['Resultado reaproveitado de pesquisa recente por identificador forte.'],
    source_url: product.source_url, source_domain: product.source_domain, source_title: meta.source_title || null,
    research_status: 'CONFIRMADO', match_level: meta.match_level || 'forte', match_confidence: Number(product.research_confidence || 0.95),
    evidence: meta.evidence || ['Produto já confirmado na ANV'], researched_at: product.researched_at,
    candidates: meta.candidates || [], image_urls: meta.image_urls || [], identifiers: identifiersFrom(clues),
    existing_product_id: product.id, image_hash: imageHash, cached: true, source: 'web_research_cache'
  };
}

function makeConfirmedResponse({ clues, facts, source, match, research, existing, imageHash }) {
  const evidence = Array.from(new Set([...(match.selected?.evidence || []), ...(source.candidate?.evidence || [])])).slice(0, 15);
  const conf = match.confidence;
  const name = facts.name || source.candidate.name || source.candidate.title || clues.name_hint || clues.product_type || 'Produto identificado';
  return {
    product_type: clues.product_type,
    name,
    brand: facts.brand || clues.brand || source.candidate.brand || null,
    model: facts.model || clues.model || source.candidate.model || null,
    material: facts.material,
    application: facts.application,
    compatibility: facts.compatibility,
    description: facts.description,
    technical_details: facts.technical_details || (Object.keys(facts.specifications || {}).length ? JSON.stringify(facts.specifications) : null),
    code: facts.code || clues.code || source.candidate.code || null,
    sku: facts.sku || clues.sku || null,
    gtin: facts.ean || clues.ean || source.candidate.ean || null,
    part_number: facts.part_number || clues.part_number || source.candidate.part_number || null,
    manufacturer: facts.manufacturer || clues.manufacturer || source.candidate.manufacturer || null,
    line: facts.line || clues.line || null,
    measurements: facts.measurements,
    suggested_category_terms: facts.category_terms,
    visible_text: clues.visible_text,
    confidence: conf,
    field_confidence: { name: Math.max(conf, 0.9), brand: conf, model: conf, material: Math.min(conf, 0.9), application: Math.min(conf, 0.88), compatibility: Math.min(conf, 0.9) },
    needs_confirmation: [],
    warnings: Array.from(new Set([...(clues.warnings || []), ...(facts.warnings || [])])),
    source_url: source.page.url,
    source_domain: new URL(source.page.url).hostname,
    source_title: source.evidence.title || source.candidate.title || null,
    research_status: 'CONFIRMADO',
    match_level: match.match_level,
    match_confidence: conf,
    evidence,
    researched_at: new Date().toISOString(),
    candidates: match.candidates,
    image_urls: facts.image_urls,
    identifiers: identifiersFrom(clues),
    existing_product_id: existing?.id || null,
    image_hash: imageHash,
    web_search_model: research?.model || null,
    search_queries: research?.queries || [],
    cached: false,
    source: 'image_web_research'
  };
}

function makePendingResponse(clues, match, research, existing, imageHash, warnings = []) {
  return {
    product_type: clues.product_type,
    name: clues.name_hint || clues.product_type || 'Produto não confirmado',
    brand: clues.brand, model: clues.model, material: null, application: null, compatibility: null,
    description: null, technical_details: null, code: clues.code, sku: clues.sku, gtin: clues.ean,
    suggested_category_terms: [], visible_text: clues.visible_text, confidence: Math.min(0.69, match.confidence || clues.confidence || 0.35),
    field_confidence: { name: 0.45, brand: clues.brand ? 0.7 : 0, model: clues.model ? 0.7 : 0, material: 0, application: 0, compatibility: 0 },
    needs_confirmation: ['produto exato'],
    warnings: Array.from(new Set([...(clues.warnings || []), ...warnings])),
    source_url: null, source_domain: null, source_title: null,
    research_status: 'PRODUTO_NAO_CONFIRMADO', match_level: 'insuficiente', match_confidence: match.confidence || 0,
    evidence: [], researched_at: new Date().toISOString(), candidates: match.candidates || [], image_urls: [], identifiers: identifiersFrom(clues),
    existing_product_id: existing?.id || null, image_hash: imageHash, web_search_model: research?.model || null, search_queries: research?.queries || [], cached: false,
    source: 'image_web_research'
  };
}

async function handleManualUrl(body) {
  const rawClues = body?.clues || body?.identifiers || {};
  const clues = normalizeClues({ ...rawClues, visible_text: rawClues.visible_text || [], visual_features: rawClues.visual_features || [] });
  const manualUrl = String(body?.manual_url || '').trim();
  const page = await safeFetchPage(manualUrl);
  const evidence = extractPageEvidence(page);
  const candidate = cleanCandidate({ url: page.url, domain: new URL(page.url).hostname, title: evidence.title, source_type: 'other', brand: null, model: null, code: null, ean: null, evidence: ['URL informada manualmente para validação'] });
  const provisional = scoreCandidate(candidate, clues);
  candidate.evidence = [...candidate.evidence, ...provisional.evidence];
  const source = { candidate, page, evidence };
  const facts = await extractFactsFromSource(source, clues);
  const enriched = cleanCandidate({ ...candidate, ...facts, url: page.url, title: evidence.title, image_url: facts.image_urls?.[0], evidence: candidate.evidence });
  const match = chooseMatch([enriched], clues);
  const strongKnown = clues.ean || clues.part_number || clues.code || clues.sku || clues.reference || (clues.brand && clues.model);
  if (!match.selected && strongKnown) return makePendingResponse(clues, { ...match, candidates: [{ ...enriched, ...scoreCandidate(enriched, clues) }] }, { queries: [], model: null }, null, null, ['A URL informada não comprovou correspondência suficiente.']);
  const manualMatch = match.selected ? match : { ...match, selected: enriched, status: 'CONFIRMADO', match_level: 'provavel', confidence: strongKnown ? 0.8 : 0.72, candidates: [{ ...enriched, ...scoreCandidate(enriched, clues) }] };
  return makeConfirmedResponse({ clues, facts, source, match: manualMatch, research: { queries: [], model: null }, existing: null, imageHash: null });
}

async function processImage(image) {
  const imageHash = crypto.createHash('sha256').update(image).digest('hex');
  const clues = await analyzeImageClues(image);
  const existing = await findExisting(clues).catch(() => null);
  if (existing && cacheFresh(existing) && (clues.ean || clues.part_number || clues.code || clues.sku || clues.reference)) return responseFromCached(existing, clues, imageHash);

  const research = await webResearch(clues);
  const match = chooseMatch(research.candidates, clues);
  if (!match.selected) return makePendingResponse(clues, match, research, existing, imageHash);
  let source;
  try { source = await findUsableSource(match); }
  catch { return makePendingResponse(clues, { ...match, status: 'PRODUTO_NAO_CONFIRMADO', match_level: 'insuficiente', confidence: Math.min(match.confidence, 0.69), selected: null }, research, existing, imageHash, ['Foram encontrados candidatos, mas nenhuma fonte confiável pôde ser acessada para validar os dados.']); }
  const facts = await extractFactsFromSource(source, clues);
  return makeConfirmedResponse({ clues, facts, source, match, research, existing, imageHash });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { detail: 'Método não permitido' });
  const cookies = parseCookies(req.headers.cookie || '');
  const user = readSession(cookies.anv_session);
  if (!user) return json(res, 401, { detail: 'Sessão inválida ou expirada' });
  try {
    if (!(await ensureWriteAccess(user))) return json(res, 423, { detail: 'Aguardando liberação do sistema', code: 'ANV_ACCESS_PENDING' });
  } catch (e) {
    if (e?.message === 'database_unavailable') return json(res, 503, { detail: 'Controle de acesso temporariamente indisponível' });
    throw e;
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return json(res, 400, { detail: 'JSON inválido' }); } }
  body = body || {};
  try {
    if (body.manual_url) return json(res, 200, await handleManualUrl(body));
    const image = String(body.image_data_url || '').trim();
    if (!image.startsWith('data:image/') || !image.includes(';base64,')) return json(res, 400, { detail: 'Imagem inválida' });
    if (image.length > 6_000_000) return json(res, 413, { detail: 'Imagem muito grande' });
    return json(res, 200, await processImage(image));
  } catch (e) {
    console.error('[ANV research]', { stage: e?.message, status: e?.status, detail: cleanText(e?.detail, 500) });
    if (e?.message === 'gateway_token_unavailable') return json(res, 503, { detail: 'Autenticação de IA indisponível' });
    if (e?.message === 'gateway_error') return json(res, 502, { detail: { message: 'Falha no AI Gateway', status: e.status } });
    if (e?.message === 'unsafe_url') return json(res, 400, { detail: 'URL não permitida para pesquisa' });
    if (String(e?.message || '').startsWith('source_http_') || ['source_not_html', 'no_accessible_source', 'web_search_failed'].includes(e?.message)) return json(res, 502, { detail: `Falha na etapa de pesquisa/fonte: ${e.message}` });
    return json(res, 502, { detail: `Falha na etapa ${e?.message || 'desconhecida'}` });
  }
}
