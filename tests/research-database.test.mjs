import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
const sql=await fs.readFile(new URL('../supabase/003_anv_product_research.sql',import.meta.url),'utf8');
let db;
test('research migration and transactional save on a real embedded PostgreSQL engine',async t=>{
 db=new PGlite({extensions:{pgcrypto}});
 await db.exec('create role anon; create role authenticated; create role service_role;');
 await db.exec(await fs.readFile(new URL('../supabase/001_anv_core.sql',import.meta.url),'utf8'));
 await db.exec(await fs.readFile(new URL('../supabase/002_anv_access_control.sql',import.meta.url),'utf8'));
 await db.exec(sql);
 await db.exec(sql); // migration may be safely applied again
 const research=async(status='DADOS_IMPORTADOS')=>(await db.query(`insert into anv_product_research(actor_email,status,original_image,selected_candidate,source_confidence,source_url,source_title,matched_fields) values('unit@example.invalid',$1,'data:image/jpeg;base64,/9j/', '{"fields":{"name":"Unit evidence"}}',95,'https://example.com/unit','Unit evidence','{"name":{"quote":"Unit evidence"}}') returning id`,[status])).rows[0].id;
 const save=async(id,fields,actor='unit@example.invalid',existing=null)=>(await db.query('select anv_save_researched_product($1,$2,$3::jsonb,$4) as product',[id,actor,JSON.stringify(fields),existing])).rows[0].product;
 await t.test('unconfirmed and other-user research cannot save',async()=>{
   const id=await research('AGUARDANDO_CONFIRMACAO');await assert.rejects(save(id,{name:'Unit evidence'}),/research_confirmation_required/);
   await assert.rejects(save(id,{name:'Unit evidence'},'another@example.invalid'),/research_not_found/);
 });
 await t.test('save is atomic and retry returns the same product without duplicate photos',async()=>{
   const id=await research();const p=await save(id,{name:'Unit evidence',sale_price:321.5,stock:7});
   assert.equal(p.sale_price,321.5);assert.equal(p.stock,7);
   const again=await save(id,{name:'Different retry'});assert.equal(again.id,p.id);
   const photos=(await db.query('select * from anv_product_images where product_id=$1',[p.id])).rows;assert.equal(photos.length,1);assert.equal(photos[0].kind,'source');
   const source=(await db.query('select * from anv_product_research where id=$1',[id])).rows[0];assert.equal(source.product_id,p.id);assert.equal(source.source_url,'https://example.com/unit');
 });
 await t.test('failed product validation rolls back all rows and leaves retry possible',async()=>{
   const id=await research();const before=(await db.query('select count(*)::int as n from anv_products')).rows[0].n;
   await assert.rejects(save(id,{name:'Unit evidence',stock:-1}),/anv_products_stock_check/);
   assert.equal((await db.query('select count(*)::int as n from anv_products')).rows[0].n,before);
   assert.equal((await db.query('select product_id from anv_product_research where id=$1',[id])).rows[0].product_id,null);
   assert.ok((await save(id,{name:'Unit evidence',stock:1})).id);
 });
 await t.test('existing product imports preserve operational values and existing images',async()=>{
   const first=await research();const p=await save(first,{name:'Original unit',sale_price:432.1,stock:9,sku:'LOCAL'});
   const next=await research();const updated=await save(next,{material:'Unit material'},'unit@example.invalid',p.id);
   assert.equal(updated.id,p.id);assert.equal(updated.name,'Original unit');assert.equal(updated.sale_price,432.1);assert.equal(updated.stock,9);assert.equal(updated.sku,'LOCAL');
   assert.equal((await db.query('select count(*)::int as n from anv_product_images where product_id=$1',[p.id])).rows[0].n,2);
   await assert.rejects(save(next,{name:'Unit'},'unit@example.invalid','00000000-0000-0000-0000-000000000001'),/research_product_mismatch/);
 });
 await t.test('publication updates research state/history without exposing it to anonymous users',async()=>{
   const id=await research();const p=await save(id,{name:'Unit evidence'});
   await db.query("update anv_products set status='publicado' where id=$1",[p.id]);
   const r=(await db.query('select status,status_history from anv_product_research where id=$1',[id])).rows[0];assert.equal(r.status,'PUBLICADO');assert.equal(r.status_history.at(-1).status,'PUBLICADO');
   await db.exec('set role anon');await assert.rejects(db.query('select * from anv_product_research'),/permission denied/);await db.exec('reset role');
 });
 await db.close();
});
