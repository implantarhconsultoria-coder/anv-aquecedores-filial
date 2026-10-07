import { getVercelOidcToken } from '@vercel/oidc';

const PROJECT_ID = 'prj_L8E2o1UByRs55MjwYUsLcII6kI6F';
const TEAM_ID = 'team_EF2ynCny10Wt5LjD5O3f2FhM';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok:false });
  try {
    const token = process.env.AI_GATEWAY_API_KEY || await getVercelOidcToken({ project: PROJECT_ID, team: TEAM_ID, expirationBufferMs: 60_000 });
    const r = await fetch('https://ai-gateway.vercel.sh/v1/messages', {
      method:'POST',
      headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
      body:JSON.stringify({
        model:'anthropic/claude-sonnet-5',
        max_tokens:500,
        tools:[{ type:'web_search_20250305', name:'web_search', max_uses:1 }],
        messages:[{ role:'user', content:'Use web search to find the official Rinnai Brasil website. Reply with JSON only: {"url":"...","title":"..."}.' }]
      })
    });
    const raw = await r.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    const types = Array.isArray(data?.content) ? data.content.map(x => x?.type).filter(Boolean) : [];
    const text = Array.isArray(data?.content) ? data.content.filter(x => x?.type === 'text').map(x => x.text || '').join('\n').slice(0,1000) : '';
    return res.status(r.ok ? 200 : 502).json({ ok:r.ok, status:r.status, model:'anthropic/claude-sonnet-5', content_types:types, text });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}
