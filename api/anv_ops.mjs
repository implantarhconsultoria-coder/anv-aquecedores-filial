import crypto from 'node:crypto';

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
    return {
      ...p,
      images: byProductImages.get(String(p.id)) || [],
      marketplace_status: listing?.status || null,
      item_id: listing?.item_id || null,
      user_product_id: listing?.user_product_id || null,
      permalink: listing?.permalink || null,
      listing: listing || null
    };
  });
}

async function saveImage(body) {
  const productId = String(body.product_id || '');
  const url = String(body.url || '');
  if (!productId || !url.startsWith('data:image/')) throw new Error('Imagem ou produto inválido');
  if (url.length > 5_500_000) throw new Error('Imagem muito grande');
  if (body.is_main) {
    await sb('PATCH', 'anv_product_images', {
      params: { product_id: `eq.${productId}` }, body: { is_main: false }, prefer: 'return=minimal'
    });
  }
  const row = {
    product_id: productId,
    kind: String(body.kind || 'generated'),
    position: Number(body.position || 0),
    is_main: !!body.is_main,
    url,
    mime: String(body.mime || 'image/jpeg')
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
    const e = new Error('Produto possui anúncio ativo no Mercado Livre. Encerre o anúncio antes de excluir o cadastro.');
    e.status = 409;
    e.detail = { item_id: published.item_id, permalink: published.permalink, status: published.status };
    throw e;
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

export default async function handler(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  if (!readSession(cookies.anv_session)) return json(res, 401, { detail: 'Sessão inválida ou expirada' });
  try {
    const url = new URL(req.url, 'https://anv.local');
    if (req.method === 'GET' && url.searchParams.get('action') === 'catalog') return json(res, 200, await catalog());
    if (req.method !== 'POST') return json(res, 405, { detail: 'Método não permitido' });
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    body = body || {};
    const action = String(body.action || '');
    if (action === 'save_image') return json(res, 200, await saveImage(body));
    if (action === 'delete_generated') return json(res, 200, await deleteGenerated(String(body.product_id || '')));
    if (action === 'delete_image') {
      await sb('DELETE', 'anv_product_images', { params: { id: `eq.${String(body.image_id || '')}` } });
      return json(res, 200, { ok: true });
    }
    if (action === 'set_main') return json(res, 200, await setMain(body));
    if (action === 'delete_product') return json(res, 200, await deleteProduct(String(body.product_id || '')));
    return json(res, 400, { detail: 'Ação inválida' });
  } catch (e) {
    return json(res, Number(e.status || 500), { detail: e.message || 'Falha na operação ANV', context: e.detail || null });
  }
}
