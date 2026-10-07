import { getVercelOidcToken } from '@vercel/oidc';

const PROJECT_ID = 'prj_L8E2o1UByRs55MjwYUsLcII6kI6F';
const TEAM_ID = 'team_EF2ynCny10Wt5LjD5O3f2FhM';

async function call(url, token, body) {
  const r = await fetch(url, { method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' }, body:JSON.stringify(body) });
  const raw = await r.text();
  return { ok:r.ok, status:r.status, raw:raw.slice(0,900) };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok:false });
  try {
    const token = process.env.AI_GATEWAY_API_KEY || await getVercelOidcToken({ project: PROJECT_ID, team: TEAM_ID, expirationBufferMs: 60_000 });
    const openai = await call('https://ai-gateway.vercel.sh/v1/chat/completions', token, {
      model:'openai/gpt-5-mini', messages:[{role:'user',content:'Reply only OK'}], max_completion_tokens:20
    });
    const anthropic = await call('https://ai-gateway.vercel.sh/v1/messages', token, {
      model:'anthropic/claude-sonnet-5', max_tokens:60, messages:[{role:'user',content:'Reply only OK'}]
    });
    const anthropicWeb = await call('https://ai-gateway.vercel.sh/v1/messages', token, {
      model:'anthropic/claude-sonnet-5', max_tokens:500,
      tools:[{ type:'web_search_20250305', name:'web_search', max_uses:1 }],
      messages:[{ role:'user', content:'Use web search to find the official Rinnai Brasil website. Reply with JSON only: {"url":"...","title":"..."}.' }]
    });
    return res.status(200).json({ token_source:process.env.AI_GATEWAY_API_KEY?'api_key':'oidc', openai, anthropic, anthropic_web:anthropicWeb });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}
