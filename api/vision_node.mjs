import crypto from 'node:crypto';
import { getVercelOidcToken } from '@vercel/oidc';

const PROJECT_ID = 'prj_L8E2o1UByRs55MjwYUsLcII6kI6F';
const TEAM_ID = 'team_EF2ynCny10Wt5LjD5O3f2FhM';
const MODEL = 'openai/gpt-5-mini';

const PROMPT = `Você é o motor de cadastro inteligente da ANV Filial Digital, um catálogo MULTIMARCAS de peças, componentes e acessórios para aquecedores a gás.

REGRA CENTRAL: analise SOMENTE o que pode ser sustentado pela imagem. Não assuma fabricante, marca, modelo, aplicação ou compatibilidade por contexto do sistema, histórico da empresa ou conhecimento prévio.

Antes de preencher qualquer campo, determine se a imagem mostra:
1) uma peça/componente/acessório isolado; ou
2) um aparelho/aquecedor completo.

Se for um aquecedor completo, product_type deve indicar claramente "aquecedor completo" e warnings deve informar que o item está fora do escopo inicial de peças da ANV. NÃO transforme um aquecedor completo em peça e NÃO transforme uma peça em aquecedor completo.

Objetivo: preencher um cadastro de produto para posterior publicação no Mercado Livre.

Retorne EXCLUSIVAMENTE um JSON válido com esta estrutura:
{
  "product_type": "tipo genérico do item",
  "name": "nome comercial objetivo e seguro",
  "brand": null,
  "model": null,
  "material": null,
  "application": null,
  "compatibility": null,
  "description": "descrição curta baseada no que é visível",
  "technical_details": "características técnicas realmente observáveis",
  "suggested_category_terms": ["termo 1", "termo 2"],
  "visible_text": ["somente textos/códigos realmente legíveis na imagem"],
  "confidence": 0.0,
  "field_confidence": {
    "name": 0.0,
    "brand": 0.0,
    "model": 0.0,
    "material": 0.0,
    "application": 0.0,
    "compatibility": 0.0
  },
  "needs_confirmation": ["campos que não podem ser confirmados pela foto"],
  "warnings": ["qualquer alerta importante"]
}

Regras obrigatórias:
- brand só pode ser preenchido quando a marca estiver legível na foto ou houver evidência visual inequívoca. Caso contrário, brand deve ser null.
- Rinnai NÃO deve ser inferido apenas porque o sistema ANV trabalha com produtos Rinnai.
- model só pode ser preenchido quando o modelo/código estiver legível e inequívoco. Não deduza modelo por aparência.
- Não deduza dimensões, peso, tensão, potência, código de peça, pinagem, GTIN/EAN, NCM ou especificações numéricas pela aparência.
- Não diga que uma peça serve em modelos específicos sem código/identificação suficiente.
- Para placa/display/painel eletrônico, diferencie placa de controle, display/interface e chicote/cabo somente quando isso estiver visualmente sustentado.
- Em visible_text coloque SOMENTE caracteres alfanuméricos realmente legíveis; não descreva ícones e, se um número estiver ambíguo, omita.
- material só pode ser preenchido se for visualmente evidente com boa confiança; aparência semelhante não basta.
- application e compatibility devem permanecer null quando forem apenas uma suposição provável.
- O nome deve ser útil para estoque e anúncio, mas genérico o suficiente para não afirmar o que não foi comprovado.
- confidence e field_confidence variam de 0 a 1 e devem refletir incerteza real, não otimismo.`;

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

async function ensureWriteAccess(user) {
  if (isOwnerSession(user)) return true;
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base || !key) throw new Error('access_database_unavailable');
  const email = String(user?.email || '').toLowerCase().trim();
  const u = new URL(`${base}/rest/v1/anv_access_users`);
  u.searchParams.set('select', 'access_status,active');
  u.searchParams.set('email', `eq.${email}`);
  u.searchParams.set('limit', '1');
  const r = await fetch(u, { headers: { apikey:key, Authorization:`Bearer ${key}` } });
  if (!r.ok) throw new Error('access_database_unavailable');
  const rows = await r.json();
  const record = rows?.[0];
  if (!record || !record.active) return false;
  return String(record.access_status || 'AGUARDANDO_LIBERACAO') === 'LIBERADO';
}

async function gatewayToken() {
  if (process.env.AI_GATEWAY_API_KEY) return process.env.AI_GATEWAY_API_KEY;
  return await getVercelOidcToken({ project: PROJECT_ID, team: TEAM_ID, expirationBufferMs: 60_000 });
}

async function analyzeImage(imageDataUrl) {
  const token = await gatewayToken();
  if (!token) throw new Error('gateway_token_unavailable');

  const response = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } }
        ]
      }],
      response_format: { type: 'json_object' },
      max_completion_tokens: 1600
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    const err = new Error('gateway_error');
    err.status = response.status;
    err.detail = raw.slice(0, 1000);
    throw err;
  }

  let envelope;
  try { envelope = JSON.parse(raw); } catch { throw new Error('gateway_invalid_json'); }
  const content = envelope?.choices?.[0]?.message?.content;
  if (!content) throw new Error('empty_model_response');

  let result;
  try { result = JSON.parse(content); } catch { throw new Error('model_invalid_json'); }

  const allowed = [
    'product_type','name','brand','model','material','application','compatibility',
    'description','technical_details','suggested_category_terms','visible_text','confidence',
    'field_confidence','needs_confirmation','warnings'
  ];
  const clean = {};
  for (const key of allowed) clean[key] = result?.[key] ?? null;
  clean.source = 'image_ai';
  clean.model_used = MODEL;
  return clean;
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
  if (!image.startsWith('data:image/') || !image.includes(';base64,')) {
    return json(res, 400, { detail: 'Imagem inválida' });
  }
  if (image.length > 6_000_000) return json(res, 413, { detail: 'Imagem muito grande' });

  try {
    const result = await analyzeImage(image);
    return json(res, 200, result);
  } catch (e) {
    if (e?.message === 'gateway_token_unavailable') return json(res, 503, { detail: 'Autenticação de IA indisponível' });
    if (e?.message === 'gateway_error') return json(res, 502, { detail: { message: 'Falha no AI Gateway', status: e.status, gateway: e.detail } });
    return json(res, 502, { detail: `Falha na análise: ${e?.message || 'erro desconhecido'}` });
  }
}
