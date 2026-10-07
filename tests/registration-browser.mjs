// UI regression only. No mocked HTTP, credentials, product matches or saved products.
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
const base=process.env.ANV_TEST_BASE_URL||'http://127.0.0.1:3000';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true});
try {
 for(const mode of ['desktop','mobile']) {
  const page=await browser.newPage({viewport:mode==='desktop'?{width:1440,height:1000}:{width:390,height:844}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/${mode}`,{waitUntil:'networkidle'});
  await page.evaluate(()=>novo()); // render the real registration component, without claiming a login
  await page.waitForFunction(()=>document.getElementById('photo')?.dataset.anvAiBound==='1');
  assert.equal(await page.locator('#save').textContent(),'SALVAR PRODUTO');
  await page.locator('#price').fill('149.9');await page.locator('#qty').fill('7');
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=16;c.height=16;return c.toDataURL('image/png').split(',')[1];});
  await page.locator('#photo').setInputFiles({name:'ui-input-vector.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await page.locator('#anv-search-product').waitFor();
  assert.equal(await page.locator('#title').inputValue(),'');
  await page.locator('#save').click();assert.match(await page.locator('#msg').textContent(),/Pesquise e confirme/);
  const response=page.waitForResponse(r=>r.url().endsWith('/api/ai/product-research'));
  await page.locator('#anv-search-product').click();assert.equal((await response).status(),401);
  await page.waitForFunction(()=>document.getElementById('anv-ai-photo-result')?.textContent.includes('Sessão inválida'));
  assert.ok(!(await page.locator('#anv-ai-photo-result').textContent()).includes('empty_model_response'));
  assert.equal(await page.locator('#price').inputValue(),'149.9');assert.equal(await page.locator('#qty').inputValue(),'7');
  await page.locator('#anv-manual-product').click();assert.match(await page.locator('#anv-ai-photo-result').textContent(),/Cadastro manual selecionado/);
  await page.evaluate(()=>novo());await page.waitForFunction(()=>document.getElementById('photo')?.dataset.anvAiBound==='1');
  assert.equal(await page.locator('#anv-ai-photo-result').count(),0);assert.equal(await page.locator('#title').inputValue(),'');
  assert.deepEqual(errors,[]);console.log(`${mode}: real UI upload, explicit search, real API 401, manual fallback, unchanged price/stock and clean form reset passed`);
  await page.close();
 }
} finally {await browser.close();}
