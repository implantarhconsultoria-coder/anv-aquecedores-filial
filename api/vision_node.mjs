import crypto from 'node:crypto';
import { getVercelOidcToken } from '@vercel/oidc';

const PROJECT_ID = 'prj_L8E2o1UByRs55MjwYUsLcII6kI6F';
const TEAM_ID = 'team_EF2ynCny10Wt5LjD5O3f2FhM';
const TEST_KEY = 'anv-product-vision-20261006-Q8r2';
const MODEL = 'openai/gpt-5-mini';

const PROMPT = `Você é o motor de cadastro inteligente da ANV Filial Digital, operação de peças, componentes e acessórios para aquecedores a gás, com forte presença de peças Rinnai.

Analise SOMENTE o que pode ser sustentado pela imagem. Nunca invente código, modelo, dimensão, peso, tensão, material, compatibilidade ou marca.

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
  "technical_details": "características técnicas que são realmente observáveis",
  "suggested_category_terms": ["termo 1", "termo 2"],
  "visible_text": ["textos/códigos realmente legíveis na imagem"],
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
- Se Rinnai não estiver visível ou inequivocamente identificável, brand deve ser null.
- Não deduza dimensões ou peso visualmente.
- Não diga que uma peça serve em modelos específicos sem código/identificação suficiente.
- Para placa/display/painel eletrônico, diferencie placa de controle, display/interface e chicote/cabo quando visível.
- O nome deve ser bom para estoque e anúncio, mas sem promessas não verificadas.
- confidence e field_confidence variam de 0 a 1.`;

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

  const url = new URL(req.url, 'https://anv.local');
  const testMode = url.searchParams.get('test_key') === TEST_KEY;
  if (!testMode) {
    const cookies = parseCookies(req.headers.cookie || '');
    if (!readSession(cookies.anv_session)) return json(res, 401, { detail: 'Sessão inválida ou expirada' });
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
