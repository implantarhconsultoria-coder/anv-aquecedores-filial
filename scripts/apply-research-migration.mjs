// Requires explicit operational authorization and server-side management credentials.
import fs from 'node:fs/promises';
const token=process.env.ANV_SUPABASE_ACCESS_TOKEN;
const base=process.env.SUPABASE_URL;
if(!token||!base)throw new Error('Configure ANV_SUPABASE_ACCESS_TOKEN e SUPABASE_URL de forma segura antes de aplicar a migração.');
const url=new URL(base);
const ref=url.hostname.match(/^([a-z0-9]+)\.supabase\.co$/)?.[1];
if(url.protocol!=='https:'||!ref)throw new Error('SUPABASE_URL deve apontar para o projeto Supabase ANV.');
const sql=await fs.readFile(new URL('../supabase/003_anv_product_research.sql',import.meta.url),'utf8');
const r=await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({query:sql}),signal:AbortSignal.timeout(60000)});
if(!r.ok)throw new Error(`Migração não confirmada: Supabase Management HTTP ${r.status}. Nenhuma credencial foi exibida.`);
console.log('Migração 003 aplicada pelo Supabase Management API.');
