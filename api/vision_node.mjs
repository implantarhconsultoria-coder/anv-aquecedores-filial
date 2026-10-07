import crypto from 'node:crypto';

import { extractHints, functionalError } from '../lib/research-ai.mjs';

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  }
  return out;
}

export function readSession(token) {
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
  } catch {
    return null;
  }
}

function isOwnerSession(user) {
  const email = String(user?.email || '').toLowerCase().trim();
  const role = String(user?.role || '').toLowerCase();
  const owner = String(process.env.ANV_LOGIN_EMAIL || '').toLowerCase().trim();
  return !!email && email === owner && ['owner','admin'].includes(role);
}

export async function ensureWriteAccess(user) {
  if (isOwnerSession(user)) return true;
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base || !key) throw new Error('access_database_unavailable');
  const email = String(user?.email || '').toLowerCase().trim();
  const u = new URL(`${base}/rest/v1/anv_access_users`);
  u.searchParams.set('select', 'access_status,active');
  u.searchParams.set('email', `eq.${email}`);
  u.searchParams.set('limit', '1');
  const r = await fetch(u, { headers: { apikey:key, Authorization:`Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('access_database_unavailable');
  const rows = await r.json();
  const record = rows?.[0];
  if (!record || !record.active) return false;
  return String(record.access_status || 'AGUARDANDO_LIBERACAO') === 'LIBERADO';
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { detail: 'Método não permitido' });

  const cookies = parseCookies(req.headers.cookie || '');
  const user = readSession(cookies.anv_session);
  if (!user) return json(res, 401, { detail: 'Sessão inválida ou expirada' });
  try {
    if (!(await ensureWriteAccess(user))) return json(res, 423, { detail: 'Aguardando liberação do sistema', code:'ANV_ACCESS_PENDING' });
  } catch (e) {
    if (e?.message === 'access_database_unavailable') return json(res, 503, { detail: 'Controle de acesso temporariamente indisponível' });
    throw e;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return json(res, 400, { detail: 'JSON inválido' }); }
  }
  const image = String(body?.image_data_url || '').trim();
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) {
    return json(res, 400, { detail: 'Imagem inválida' });
  }
  if (image.length > 3_500_000) return json(res, 413, { detail: 'Imagem muito grande' });

  try {
    const result = await extractHints(image);
    return json(res, 200, result);
  } catch (e) {
    console.error('[ANV hints]', e?.message || 'analysis_failed');
    const error = functionalError(e);
    return json(res, error.status, { detail: error.detail });
  }
}
