import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

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

function sbConfig() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('Banco ANV não configurado');
  return { url, key };
}

async function sb(method, table, { params = {}, body, prefer } = {}) {
  const { url, key } = sbConfig();
  const u = new URL(`${url}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(u, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const e = new Error('Falha no banco ANV');
    e.status = r.status;
    e.detail = data;
    throw e;
  }
  return data;
}

function isOwnerSession(user) {
  const email = String(user?.email || '').toLowerCase().trim();
  const role = String(user?.role || '').toLowerCase();
  const owner = String(process.env.ANV_LOGIN_EMAIL || '').toLowerCase().trim();
  return !!email && email === owner && ['owner','admin'].includes(role);
}

async function ensureWriteAccess(user) {
  if (isOwnerSession(user)) return;
  const email = String(user?.email || '').toLowerCase().trim();
  const rows = await sb('GET', 'anv_access_users', { params: { select: '*', email: `eq.${email}`, limit: '1' } }) || [];
  const record = rows[0];
  if (!record || !record.active) {
    const e = new Error('Acesso não encontrado ou desativado'); e.status = 403; throw e;
  }
  if (String(record.access_status || 'AGUARDANDO_LIBERACAO') !== 'LIBERADO') {
    const e = new Error('Aguardando liberação do sistema'); e.status = 423;
    e.detail = { access_status: record.access_status || 'AGUARDANDO_LIBERACAO', code: 'ANV_ACCESS_PENDING' };
    throw e;
  }
}

async function catalog() {
  const products = await sb('GET', 'anv_products', { params: { select: '*', order: 'created_at.desc', limit: '500' } }) || [];
  const images = await sb('GET', 'anv_product_images', { params: { select: '*', order: 'position.asc', limit: '3000' } }) || [];
  const listings = await sb('GET', 'anv_marketplace_listings', { params: { select: '*', order: 'created_at.desc', limit: '1000' } }) || [];
  const byProductImages = new Map();
  for (const image of images) {
    const k = String(image.product_id || '');
    if (!byProductImages.has(k)) byProductImages.set(k, []);
    byProductImages.get(k).push(image);
  }
  const latestListing = new Map();
  for (const listing of listings) {
    const k = String(listing.product_id || '');
    if (!latestListing.has(k)) latestListing.set(k, listing);
  }
  return products.map(p => {
    const listing = latestListing.get(String(p.id)) || null;
    return { ...p, images: byProductImages.get(String(p.id)) || [], marketplace_status: listing?.status || null,
      item_id: listing?.item_id || null, user_product_id: listing?.user_product_id || null, permalink: listing?.permalink || null, listing };
  });
}

async function saveImage(body) {
  const productId = String(body.product_id || '');
  const url = String(body.url || '');
  if (!productId || !url.startsWith('data:image/')) throw new Error('Imagem ou produto inválido');
  if (url.length > 5_500_000) throw new Error('Imagem muito grande');
  if (body.is_main) {
    await sb('PATCH', 'anv_product_images', { params: { product_id: `eq.${productId}` }, body: { is_main: false }, prefer: 'return=minimal' });
  }
  const row = {
    product_id: productId,
    kind: String(body.kind || 'generated'),
    position: Number(body.position || 0),
    is_main: !!body.is_main,
    url,
    mime: String(body.mime || 'image/jpeg'),
    generation_prompt_hash: body.generation_prompt_hash ? String(body.generation_prompt_hash) : null
  };
  const out = await sb('POST', 'anv_product_images', { body: row, prefer: 'return=representation' });
  return Array.isArray(out) ? out[0] : out;
}

async function deleteGenerated(productId) {
  const rows = await sb('GET', 'anv_product_images', { params: { select: 'id,kind', product_id: `eq.${productId}` } }) || [];
  const generated = rows.filter(x => !['source','original'].includes(String(x.kind || '').toLowerCase()));
  for (const row of generated) await sb('DELETE', 'anv_product_images', { params: { id: `eq.${row.id}` } });
  return { deleted: generated.length };
}

async function deleteProduct(productId) {
  const listings = await sb('GET', 'anv_marketplace_listings', { params: { select: '*', product_id: `eq.${productId}`, order: 'created_at.desc', limit: '20' } }) || [];
  const published = listings.find(x => x.item_id && !['closed','inactive','deleted'].includes(String(x.status || '').toLowerCase()));
  if (published) {
    const e = new Error('Produto possui anúncio ativo no Mercado Livre. Encerre o anúncio antes de excluir o cadastro.'); e.status = 409;
    e.detail = { item_id: published.item_id, permalink: published.permalink, status: published.status }; throw e;
  }
  await sb('DELETE', 'anv_products', { params: { id: `eq.${productId}` } });
  return { ok: true };
}

async function setMain(body) {
  const productId = String(body.product_id || '');
  const imageId = String(body.image_id || '');
  if (!productId || !imageId) throw new Error('Imagem inválida');
  await sb('PATCH', 'anv_product_images', { params: { product_id: `eq.${productId}` }, body: { is_main: false }, prefer: 'return=minimal' });
  const out = await sb('PATCH', 'anv_product_images', { params: { id: `eq.${imageId}` }, body: { is_main: true, position: 0 }, prefer: 'return=representation' });
  return Array.isArray(out) ? out[0] : out;
}

function cleanText(v, max = 1000) { return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
function clamp(v) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null; }

async function saveResearch(body) {
  const productId = cleanText(body.product_id, 80);
  if (!productId) throw new Error('Produto inválido');
  const status = cleanText(body.research_status, 80) || 'PRODUTO_NAO_CONFIRMADO';
  const sourceUrl = cleanText(body.source_url, 1600) || null;
  let sourceDomain = cleanText(body.source_domain, 220) || null;
  if (sourceUrl) {
    try { sourceDomain = sourceDomain || new URL(sourceUrl).hostname; } catch { throw new Error('URL-fonte inválida'); }
  }
  const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 8).map(c => ({
    url: cleanText(c?.url, 1600), domain: cleanText(c?.domain, 220), title: cleanText(c?.title, 400), source_type: cleanText(c?.source_type, 80),
    brand: cleanText(c?.brand, 180), model: cleanText(c?.model, 180), code: cleanText(c?.code || c?.part_number, 180), ean: cleanText(c?.ean, 40),
    score: Number.isFinite(Number(c?.score)) ? Number(c.score) : null,
    evidence: Array.isArray(c?.evidence) ? c.evidence.slice(0, 8).map(x => cleanText(x, 300)) : [],
    conflicts: Array.isArray(c?.conflicts) ? c.conflicts.slice(0, 8).map(x => cleanText(x, 300)) : []
  })).filter(c => c.url) : [];
  const meta = {
    match_level: cleanText(body.match_level, 80) || null,
    source_title: cleanText(body.source_title, 500) || null,
    evidence: Array.isArray(body.evidence) ? body.evidence.slice(0, 15).map(x => cleanText(x, 400)) : [],
    identifiers: body.identifiers && typeof body.identifiers === 'object' ? body.identifiers : {},
    image_hash: cleanText(body.image_hash, 128) || null,
    image_urls: Array.isArray(body.image_urls) ? body.image_urls.slice(0, 8).map(x => cleanText(x, 1600)).filter(Boolean) : [],
    candidates,
    search_queries: Array.isArray(body.search_queries) ? body.search_queries.slice(0, 10).map(x => cleanText(x, 300)) : [],
    web_search_model: cleanText(body.web_search_model, 120) || null,
    cached: !!body.cached
  };
  const patch = {
    source_url: sourceUrl,
    source_domain: sourceDomain,
    research_status: status,
    research_confidence: clamp(body.match_confidence ?? body.confidence),
    research_meta: meta,
    researched_at: cleanText(body.researched_at, 80) || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const out = await sb('PATCH', 'anv_products', { params: { id: `eq.${productId}`, select: '*' }, body: patch, prefer: 'return=representation' });
  if (!Array.isArray(out) || !out[0]) { const e = new Error('Produto não encontrado'); e.status = 404; throw e; }
  return out[0];
}

function isPrivateIp(address) {
  const a = String(address || '').toLowerCase();
  if (a === '::1' || a === '0.0.0.0' || a.startsWith('127.') || a.startsWith('10.') || a.startsWith('192.168.') || a.startsWith('169.254.')) return true;
  const m = a.match(/^172\.(\d+)\./); if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80:');
}

async function validatePublicUrl(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('URL externa inválida');
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('URL externa inválida');
  if (isIP(host) && isPrivateIp(host)) throw new Error('URL externa inválida');
  if (!isIP(host)) {
    const addresses = await lookup(host, { all: true });
    if (!addresses.length || addresses.some(x => isPrivateIp(x.address))) throw new Error('URL externa inválida');
  }
  return u;
}

async function fetchRemoteImage(url, maxRedirects = 3) {
  let current = (await validatePublicUrl(url)).toString();
  for (let i = 0; i <= maxRedirects; i++) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12_000);
    let r;
    try { r = await fetch(current, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'ANVProductImage/1.0', Accept: 'image/*' } }); }
    finally { clearTimeout(timer); }
    if ([301,302,303,307,308].includes(r.status)) {
      const loc = r.headers.get('location'); if (!loc) throw new Error('Redirecionamento de imagem inválido');
      current = (await validatePublicUrl(new URL(loc, current).toString())).toString(); continue;
    }
    if (!r.ok) throw new Error(`Imagem externa indisponível (${r.status})`);
    const mime = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('image/') || mime.includes('svg')) throw new Error('Conteúdo externo não é uma imagem suportada');
    const declared = Number(r.headers.get('content-length') || 0); if (declared > 3_000_000) throw new Error('Imagem externa muito grande');
    const reader = r.body?.getReader?.(); const chunks = []; let total = 0;
    if (reader) {
      while (true) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength; if (total > 3_000_000) { try { await reader.cancel(); } catch {} throw new Error('Imagem externa muito grande'); } chunks.push(Buffer.from(value)); }
    } else {
      const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 3_000_000) throw new Error('Imagem externa muito grande'); chunks.push(buf); total = buf.length;
    }
    return { finalUrl: current, mime, buffer: Buffer.concat(chunks, total) };
  }
  throw new Error('Redirecionamentos excessivos na imagem externa');
}

async function importRemoteImage(body) {
  const productId = cleanText(body.product_id, 80);
  const remoteUrl = cleanText(body.url, 1800);
  if (!productId || !remoteUrl) throw new Error('Imagem ou produto inválido');
  const urlHash = crypto.createHash('sha256').update(remoteUrl).digest('hex');
  const existing = await sb('GET', 'anv_product_images', { params: { select: '*', product_id: `eq.${productId}`, generation_prompt_hash: `eq.${urlHash}`, limit: '1' } }) || [];
  if (existing[0]) return { ...existing[0], reused: true };
  const img = await fetchRemoteImage(remoteUrl);
  const dataUrl = `data:${img.mime};base64,${img.buffer.toString('base64')}`;
  return await saveImage({ product_id: productId, url: dataUrl, kind: 'external_source', position: Number(body.position || 20), is_main: false, mime: img.mime, generation_prompt_hash: urlHash });
}

export default async function handler(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  const user = readSession(cookies.anv_session);
  if (!user) return json(res, 401, { detail: 'Sessão inválida ou expirada' });
  try {
    const url = new URL(req.url, 'https://anv.local');
    if (req.method === 'GET' && url.searchParams.get('action') === 'catalog') return json(res, 200, await catalog());
    if (req.method !== 'POST') return json(res, 405, { detail: 'Método não permitido' });
    await ensureWriteAccess(user);
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    body = body || {};
    const action = String(body.action || '');
    if (action === 'save_image') return json(res, 200, await saveImage(body));
    if (action === 'save_research') return json(res, 200, await saveResearch(body));
    if (action === 'import_remote_image') return json(res, 200, await importRemoteImage(body));
    if (action === 'delete_generated') return json(res, 200, await deleteGenerated(String(body.product_id || '')));
    if (action === 'delete_image') { await sb('DELETE', 'anv_product_images', { params: { id: `eq.${String(body.image_id || '')}` } }); return json(res, 200, { ok: true }); }
    if (action === 'set_main') return json(res, 200, await setMain(body));
    if (action === 'delete_product') return json(res, 200, await deleteProduct(String(body.product_id || '')));
    return json(res, 400, { detail: 'Ação inválida' });
  } catch (e) {
    console.error('[ANV ops]', { action: req?.body?.action, message: e?.message, status: e?.status });
    return json(res, Number(e.status || 500), { detail: e.message || 'Falha na operação ANV', context: e.detail || null });
  }
}
