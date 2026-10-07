(() => {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  let aiData = null;
  let busy = false;
  let lastPhotoDataUrl = null;
  let currentProductId = null;
  let decorateTimer = null;

  const text = v => v === null || v === undefined ? '' : String(v).trim();
  const esc = v => text(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function confidenceFor(key, data) {
    const n = Number(data?.field_confidence?.[key]);
    return Number.isFinite(n) ? n : Number(data?.confidence || 0);
  }

  function fill(id, value, minConfidence, confidenceKey) {
    const el = document.getElementById(id);
    const valueText = text(value);
    if (!el || !valueText || text(el.value)) return;
    if (confidenceFor(confidenceKey || id, aiData) < minConfidence) return;
    el.value = valueText;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function getPanel(photo) {
    let panel = document.getElementById('anv-ai-photo-result');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'anv-ai-photo-result';
      panel.style.cssText = 'margin-top:10px;padding:12px 14px;border:1px solid #e5e7eb;border-radius:11px;background:#fafafa;font-size:13px;line-height:1.45;color:#4b5563';
      photo.insertAdjacentElement('afterend', panel);
    }
    return panel;
  }

  function setPanel(html) {
    const photo = document.getElementById('photo');
    if (photo) getPanel(photo).innerHTML = html;
  }

  async function imageToDataURL(file) {
    const raw = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    try {
      const img = await loadImage(raw);
      const maxSide = 1600;
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      if (scale >= 1 && String(raw).length < 3_500_000) return raw;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.88);
    } catch { return raw; }
  }

  function renderResult(data) {
    const conf = Math.max(0, Math.min(100, Math.round(Number(data.confidence || 0) * 100)));
    const details = [
      data.product_type && `<b>Tipo:</b> ${esc(data.product_type)}`,
      data.application && `<b>Aplicação:</b> ${esc(data.application)}`,
      data.compatibility && `<b>Compatibilidade:</b> ${esc(data.compatibility)}`,
      data.technical_details && `<b>Detalhes:</b> ${esc(data.technical_details)}`,
      Array.isArray(data.visible_text) && data.visible_text.length ? `<b>Texto/código visível:</b> ${esc(data.visible_text.join(' · '))}` : ''
    ].filter(Boolean).join('<br>');
    const pending = Array.isArray(data.needs_confirmation) && data.needs_confirmation.length ? `<div style="margin-top:8px;color:#92400e"><b>Confirmar:</b> ${esc(data.needs_confirmation.join(' · '))}</div>` : '';
    const warnings = Array.isArray(data.warnings) && data.warnings.length ? `<div style="margin-top:6px;color:#991b1b">${esc(data.warnings.join(' · '))}</div>` : '';
    setPanel(`<div style="color:#111;font-weight:800;margin-bottom:5px">IA identificou: ${esc(data.name || data.product_type || 'produto')} · confiança ${conf}%</div>${details || 'Imagem analisada.'}${pending}${warnings}<div style="margin-top:7px;color:#6b7280">Só campos sustentados pela foto são preenchidos. O restante fica para confirmação.</div>`);
  }

  async function analyzeData(imageData, filename = 'produto.jpg') {
    const response = await nativeFetch('/api/ai/analyze-product', {
      method: 'POST', credentials: 'include', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ image_data_url: imageData, filename })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof payload?.detail === 'string' ? payload.detail : (payload?.detail?.message || `Erro ${response.status}`));
    return payload;
  }

  async function analyze(file) {
    if (!file || busy) return;
    busy = true;
    aiData = null;
    window.__anvAiProduct = null;
    setPanel('<b style="color:#111">Analisando produto pela foto…</b><br>Identificando somente informações comprováveis.');
    try {
      lastPhotoDataUrl = await imageToDataURL(file);
      const payload = await analyzeData(lastPhotoDataUrl, file.name);
      aiData = payload;
      window.__anvAiProduct = payload;
      fill('title', payload.name, 0.62, 'name');
      fill('brand', payload.brand, 0.90, 'brand');
      fill('model', payload.model, 0.92, 'model');
      fill('material', payload.material, 0.82, 'material');
      renderResult(payload);
    } catch (error) {
      setPanel(`<span style="color:#991b1b"><b>Análise automática não concluída.</b> ${esc(error?.message || 'Tente novamente.')}</span><br>O cadastro manual continua disponível.`);
    } finally { busy = false; }
  }

  function bindPhoto() {
    const photo = document.getElementById('photo');
    if (!photo || photo.dataset.anvAiBound === '1') return;
    photo.dataset.anvAiBound = '1';
    photo.addEventListener('change', () => {
      const file = photo.files && photo.files[0];
      if (file) analyze(file);
    });
  }

  async function ops(body) {
    const r = await nativeFetch('/api/anv-ops', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(typeof d?.detail === 'string' ? d.detail : `Erro ${r.status}`);
      e.data = d;
      throw e;
    }
    return d;
  }

  async function getProduct(id) {
    const r = await nativeFetch(`/api/products/${encodeURIComponent(id)}`, {credentials:'include'});
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof d?.detail === 'string' ? d.detail : 'Produto não encontrado');
    return d;
  }

  function generatedImages(images) {
    const g = (images || []).filter(x => !['source','original'].includes(String(x.kind || '').toLowerCase()) && x.url);
    return g.length >= 5 ? g : (images || []).filter(x => x.url);
  }

  function humanMarketplaceError(payload, status) {
    const d = payload?.detail ?? payload;
    if (typeof d === 'string') return d;
    if (d?.blockers?.length) return d.blockers.join(' · ');
    const detail = d?.detail || d?.context || d;
    const causes = detail?.cause || detail?.causes || detail?.error?.cause;
    if (Array.isArray(causes) && causes.length) return causes.map(c => c.message || c.code || c.cause_id).filter(Boolean).join(' · ');
    return d?.message || detail?.message || detail?.error || `Mercado Livre recusou a operação (${status})`;
  }

  window.fetch = async function(input, init = {}) {
    let url = typeof input === 'string' ? input : input?.url || '';
    let method = String(init?.method || 'GET').toUpperCase();

    if (method === 'GET' && /\/api\/products(?:\?.*)?$/.test(url)) {
      return nativeFetch('/api/anv-ops?action=catalog', {credentials:'include'});
    }

    if (method === 'POST' && /\/api\/products(?:\?|$)/.test(url) && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        const f = aiData?.field_confidence || {};
        if (aiData?.application && Number(f.application || aiData.confidence || 0) >= 0.78) body.application = aiData.application;
        if (aiData?.compatibility && Number(f.compatibility || aiData.confidence || 0) >= 0.90) body.compatibility = aiData.compatibility;
        if (aiData?.description) body.description = aiData.description;
        if (aiData?.technical_details) body.technical_details = aiData.technical_details;
        init = {...init, body:JSON.stringify(body)};
      } catch (_) {}
      const response = await nativeFetch(input, init);
      if (response.ok) {
        try {
          const created = await response.clone().json();
          currentProductId = created?.id || currentProductId;
          if (created?.id && lastPhotoDataUrl) {
            await ops({action:'save_image', product_id:created.id, url:lastPhotoDataUrl, kind:'source', position:99, is_main:false, mime:'image/jpeg'});
          }
        } catch (_) {}
      }
      return response;
    }

    if (method === 'POST' && /\/api\/marketplace\/(preflight|publish)/.test(url) && typeof init.body === 'string') {
      let body;
      try { body = JSON.parse(init.body); } catch { body = null; }
      let publishable = [];
      if (body?.product_id) {
        try {
          const p = await getProduct(body.product_id);
          publishable = generatedImages(p.images || []);
          body.images = publishable.map(x => x.url).filter(Boolean);
          init = {...init, body:JSON.stringify(body)};
        } catch (_) {}
      }
      if (/\/publish/.test(url) && publishable.length < 5) {
        return new Response(JSON.stringify({detail:'Gere o pacote de 5 imagens comerciais antes de publicar no Mercado Livre.'}), {status:400, headers:{'Content-Type':'application/json'}});
      }
      const response = await nativeFetch(input, init);
      let payload = null;
      try { payload = await response.clone().json(); } catch (_) {}
      if (/\/preflight/.test(url) && response.ok && payload && publishable.length < 5) {
        payload.ready = false;
        payload.blockers = Array.from(new Set([...(payload.blockers || []), 'Gere o pacote de 5 imagens comerciais antes de publicar']));
        return new Response(JSON.stringify(payload), {status:response.status, headers:{'Content-Type':'application/json'}});
      }
      if (!response.ok && payload) {
        return new Response(JSON.stringify({detail:humanMarketplaceError(payload, response.status), technical:payload}), {status:response.status, headers:{'Content-Type':'application/json'}});
      }
      return response;
    }

    return nativeFetch(input, init);
  };

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.crossOrigin = 'anonymous';
      img.src = src;
    });
  }

  function wrapLines(ctx, value, x, y, maxWidth, lineHeight, maxLines = 5) {
    const words = text(value).split(/\s+/).filter(Boolean);
    let line = '', lines = [];
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word; }
      else line = test;
    }
    if (line) lines.push(line);
    lines = lines.slice(0, maxLines);
    lines.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
    return y + lines.length * lineHeight;
  }

  function drawContained(ctx, img, x, y, w, h, pad = 20) {
    const aw = w - pad * 2, ah = h - pad * 2;
    const scale = Math.min(aw / img.width, ah / img.height);
    const dw = img.width * scale, dh = img.height * scale;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  async function makeCommercialAsset(img, product, type) {
    const c = document.createElement('canvas'); c.width = 1200; c.height = 1200;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,1200,1200);
    ctx.fillStyle = '#111';
    if (type === 'cover') {
      drawContained(ctx, img, 90, 70, 1020, 1060, 40);
    } else if (type === 'presentation') {
      drawContained(ctx, img, 130, 70, 940, 800, 40);
      ctx.font = '700 46px Arial'; ctx.textAlign = 'center';
      wrapLines(ctx, product.name || 'Produto', 600, 945, 940, 58, 3);
      ctx.font = '28px Arial'; ctx.fillStyle = '#666';
      ctx.fillText([product.brand, product.model].filter(Boolean).join(' · ') || 'Produto identificado pela ANV', 600, 1090);
    } else if (type === 'identification') {
      drawContained(ctx, img, 80, 70, 560, 1060, 30);
      ctx.textAlign = 'left'; ctx.fillStyle = '#111'; ctx.font = '700 42px Arial';
      ctx.fillText('Identificação do produto', 680, 150);
      ctx.font = '30px Arial'; let y = 230;
      const lines = [
        ['Nome', product.name], ['Marca', product.brand], ['Modelo', product.model], ['Material', product.material], ['SKU', product.sku]
      ].filter(x => text(x[1]));
      for (const [k,v] of lines) { ctx.font='700 24px Arial'; ctx.fillStyle='#666'; ctx.fillText(k.toUpperCase(),680,y); y+=38; ctx.font='30px Arial'; ctx.fillStyle='#111'; y=wrapLines(ctx,v,680,y,430,40,3)+28; }
    } else if (type === 'application') {
      drawContained(ctx, img, 120, 60, 960, 620, 30);
      ctx.textAlign='left'; ctx.fillStyle='#111'; ctx.font='700 42px Arial'; ctx.fillText('Informações verificadas',100,760);
      ctx.font='29px Arial'; let y=825;
      const info = [product.application && `Aplicação: ${product.application}`, product.compatibility && `Compatibilidade: ${product.compatibility}`, product.technical_details].filter(Boolean);
      if (!info.length) info.push('Consulte o código e a aplicação correta antes da compra.');
      for (const line of info.slice(0,3)) y=wrapLines(ctx,line,100,y,1000,42,3)+22;
    } else {
      ctx.textAlign='left'; ctx.fillStyle='#111'; ctx.font='700 48px Arial'; ctx.fillText('Ficha técnica',80,105);
      drawContained(ctx, img, 680, 80, 440, 420, 30);
      let y=190;
      const specs = [
        ['Produto',product.name],['Marca',product.brand],['Modelo',product.model],['Material',product.material],['Aplicação',product.application],['Compatibilidade',product.compatibility],['SKU',product.sku]
      ].filter(x=>text(x[1]));
      for (const [k,v] of specs) { ctx.font='700 23px Arial'; ctx.fillStyle='#777'; ctx.fillText(k.toUpperCase(),80,y); y+=34; ctx.font='29px Arial'; ctx.fillStyle='#111'; y=wrapLines(ctx,v,80,y,520,38,3)+24; }
      if (product.technical_details) { ctx.font='700 23px Arial'; ctx.fillStyle='#777'; ctx.fillText('DETALHES',80,760); ctx.font='27px Arial'; ctx.fillStyle='#111'; wrapLines(ctx,product.technical_details,80,805,1040,38,7); }
    }
    return c.toDataURL('image/jpeg', 0.88);
  }

  function modal(html) {
    closeModal();
    const d = document.createElement('div'); d.id='anv-smart-modal';
    d.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:grid;place-items:center;padding:18px';
    d.innerHTML=`<div style="width:min(720px,96vw);max-height:90vh;overflow:auto;background:#fff;border-radius:18px;padding:22px;color:#111;box-shadow:0 20px 80px rgba(0,0,0,.25)">${html}</div>`;
    document.body.appendChild(d);
    d.addEventListener('click', e => { if (e.target===d) closeModal(); });
    return d;
  }
  function closeModal(){ document.getElementById('anv-smart-modal')?.remove(); }
  const fieldStyle='width:100%;border:1px solid #ddd;background:#fff;border-radius:10px;padding:11px;margin:5px 0;font:inherit';
  const btnStyle='border:0;border-radius:10px;padding:11px 15px;background:#e10600;color:#fff;font-weight:800;cursor:pointer';
  const ghostStyle='border:1px solid #222;border-radius:10px;padding:10px 14px;background:#fff;color:#111;font-weight:700;cursor:pointer';

  async function editProduct() {
    const id = await ensureCurrentProduct(); if (!id) return alert('Produto não identificado.');
    const p = await getProduct(id);
    const d = modal(`<h2 style="margin-top:0">Editar produto</h2><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <input data-f="sku" style="${fieldStyle}" placeholder="SKU" value="${esc(p.sku||'')}"><input data-f="name" style="${fieldStyle}" placeholder="Nome" value="${esc(p.name||'')}">
      <input data-f="brand" style="${fieldStyle}" placeholder="Marca" value="${esc(p.brand||'')}"><input data-f="model" style="${fieldStyle}" placeholder="Modelo" value="${esc(p.model||'')}">
      <input data-f="material" style="${fieldStyle}" placeholder="Material" value="${esc(p.material||'')}"><input data-f="sale_price" style="${fieldStyle}" type="number" step="0.01" placeholder="Preço" value="${esc(p.sale_price??0)}">
      <input data-f="stock" style="${fieldStyle}" type="number" placeholder="Estoque" value="${esc(p.stock??0)}"><input data-f="minimum_stock" style="${fieldStyle}" type="number" placeholder="Estoque mínimo" value="${esc(p.minimum_stock??5)}">
      <input data-f="application" style="${fieldStyle}" placeholder="Aplicação" value="${esc(p.application||'')}"><input data-f="compatibility" style="${fieldStyle}" placeholder="Compatibilidade" value="${esc(p.compatibility||'')}">
    </div><textarea data-f="description" style="${fieldStyle};min-height:90px" placeholder="Descrição">${esc(p.description||'')}</textarea><textarea data-f="technical_details" style="${fieldStyle};min-height:90px" placeholder="Detalhes técnicos">${esc(p.technical_details||'')}</textarea>
    <div style="display:flex;gap:8px;margin-top:12px"><button id="anv-save-edit" style="${btnStyle}">Salvar alterações</button><button id="anv-cancel-edit" style="${ghostStyle}">Cancelar</button></div>`);
    d.querySelector('#anv-cancel-edit').onclick=closeModal;
    d.querySelector('#anv-save-edit').onclick=async()=>{
      const body={}; d.querySelectorAll('[data-f]').forEach(el=>{let v=el.value; if(['sale_price'].includes(el.dataset.f))v=Number(v||0); if(['stock','minimum_stock'].includes(el.dataset.f))v=Number(v||0); body[el.dataset.f]=v||null;});
      const r=await nativeFetch(`/api/products/${encodeURIComponent(id)}`,{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const out=await r.json().catch(()=>({}));
      if(!r.ok)return alert(typeof out?.detail==='string'?out.detail:'Falha ao salvar'); closeModal(); location.reload();
    };
  }

  async function deleteProductUI(){
    const id=await ensureCurrentProduct(); if(!id)return alert('Produto não identificado.');
    if(!confirm('Deseja realmente excluir este produto?'))return;
    try{await ops({action:'delete_product',product_id:id}); currentProductId=null; location.reload();}
    catch(e){const link=e.data?.context?.permalink; alert(e.message+(link?`\n\nAnúncio: ${link}`:''));}
  }

  async function chooseFile(){return new Promise(resolve=>{const i=document.createElement('input');i.type='file';i.accept='image/*';i.onchange=()=>resolve(i.files?.[0]||null);i.click();});}

  async function generateImages(){
    const id=await ensureCurrentProduct(); if(!id)return alert('Produto não identificado.');
    let p=await getProduct(id); let images=p.images||[];
    let sources=images.filter(x=>['source','original'].includes(String(x.kind||'').toLowerCase())&&x.url);
    let source=sources[sources.length-1]?.url || images.find(x=>x.url)?.url;
    if(!source){const file=await chooseFile();if(!file)return;source=await imageToDataURL(file);await ops({action:'save_image',product_id:id,url:source,kind:'source',position:99,is_main:false,mime:'image/jpeg'});p=await getProduct(id);}
    let img; try{img=await loadImage(source);}catch{return alert('Não foi possível abrir a foto original. Selecione outra foto e tente novamente.');}
    const button=document.getElementById('anv-generate-images'); if(button){button.disabled=true;button.textContent='Gerando imagens…';}
    try{
      await ops({action:'delete_generated',product_id:id});
      const types=['cover','presentation','identification','application','technical'];
      for(let i=0;i<types.length;i++){
        const data=await makeCommercialAsset(img,p,types[i]);
        await ops({action:'save_image',product_id:id,url:data,kind:types[i],position:i,is_main:i===0,mime:'image/jpeg'});
        if(button)button.textContent=`Gerando ${i+1}/5…`;
      }
      alert('Pacote de 5 imagens comerciais gerado e salvo.'); location.reload();
    }catch(e){alert(`Falha ao gerar imagens: ${e.message}`);if(button){button.disabled=false;button.textContent='Gerar imagens';}}
  }

  async function manageImages(){
    const id=await ensureCurrentProduct(); if(!id)return alert('Produto não identificado.');
    const p=await getProduct(id); const imgs=p.images||[];
    const d=modal(`<h2 style="margin-top:0">Gerenciar imagens</h2><p style="color:#666">${imgs.length} imagem(ns) salva(s). A capa é usada primeiro no anúncio.</p><div id="anv-img-list">${imgs.map(x=>`<div style="display:flex;align-items:center;gap:10px;border-top:1px solid #eee;padding:10px 0"><img src="${esc(x.url)}" style="width:76px;height:76px;object-fit:cover;border-radius:9px"><div style="flex:1"><b>${esc(x.kind||'imagem')}</b>${x.is_main?'<div style="color:#e10600;font-size:12px">CAPA</div>':''}</div><button data-main="${esc(x.id)}" style="${ghostStyle}">Capa</button><button data-del="${esc(x.id)}" style="${ghostStyle};color:#b91c1c">Excluir</button></div>`).join('')||'<p>Nenhuma imagem persistida.</p>'}</div><button id="anv-close-img" style="${ghostStyle};margin-top:10px">Fechar</button>`);
    d.querySelector('#anv-close-img').onclick=closeModal;
    d.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(confirm('Excluir esta imagem?')){await ops({action:'delete_image',image_id:b.dataset.del});closeModal();manageImages();}});
    d.querySelectorAll('[data-main]').forEach(b=>b.onclick=async()=>{await ops({action:'set_main',product_id:id,image_id:b.dataset.main});closeModal();manageImages();});
  }

  async function reanalyzeProduct(){
    const id=await ensureCurrentProduct();if(!id)return alert('Produto não identificado.'); const file=await chooseFile();if(!file)return;
    const image=await imageToDataURL(file); let data; try{data=await analyzeData(image,file.name);}catch(e){return alert(`Análise falhou: ${e.message}`);}
    const p=await getProduct(id); const f=data.field_confidence||{}; const patch={};
    const candidates=[['name',data.name,.72],['brand',data.brand,.90],['model',data.model,.92],['material',data.material,.82],['application',data.application,.82],['compatibility',data.compatibility,.92]];
    for(const [k,v,min] of candidates)if(!text(p[k])&&text(v)&&Number(f[k]||data.confidence||0)>=min)patch[k]=v;
    if(!p.description&&data.description)patch.description=data.description;if(!p.technical_details&&data.technical_details)patch.technical_details=data.technical_details;
    const summary=`IA identificou: ${data.name||data.product_type||'produto'}\nConfiança: ${Math.round(Number(data.confidence||0)*100)}%\n\nAplicar somente sugestões confiáveis nos campos vazios?`;
    if(!confirm(summary))return;
    const r=await nativeFetch(`/api/products/${encodeURIComponent(id)}`,{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});if(!r.ok)return alert('Não foi possível atualizar o produto.');
    for(const old of (p.images||[]).filter(x=>['source','original'].includes(String(x.kind||'').toLowerCase())))await ops({action:'delete_image',image_id:old.id}).catch(()=>{});
    await ops({action:'save_image',product_id:id,url:image,kind:'source',position:99,is_main:false,mime:'image/jpeg'}); location.reload();
  }

  async function catalog(){const r=await nativeFetch('/api/anv-ops?action=catalog',{credentials:'include'});return r.ok?await r.json():[];}
  async function ensureCurrentProduct(){
    if(currentProductId)return currentProductId;
    const h=text(document.querySelector('h1')?.textContent); if(!h)return null;
    try{const list=await catalog();const matches=list.filter(x=>text(x.name)===h);if(matches.length===1)currentProductId=matches[0].id;}catch(_){}
    return currentProductId;
  }

  async function decorateProductPage(){
    bindPhoto();
    const anchor=document.getElementById('prepare')||document.getElementById('pub');
    if(!anchor||document.getElementById('anv-smart-controls'))return;
    const id=await ensureCurrentProduct(); if(!id)return;
    let p;try{p=await getProduct(id);}catch{return;}
    const commercial=(p.images||[]).filter(x=>!['source','original'].includes(String(x.kind||'').toLowerCase()));
    const div=document.createElement('div');div.id='anv-smart-controls';div.style.cssText='border:1px solid #e6e6e6;border-radius:12px;padding:12px;margin:12px 0;background:#fff';
    div.innerHTML=`<div style="font-weight:800;margin-bottom:8px">Produto · ${commercial.length>=5?'imagens prontas':'imagens pendentes'} (${Math.min(commercial.length,5)}/5)</div><div style="display:flex;gap:8px;flex-wrap:wrap"><button id="anv-edit-product" style="${ghostStyle}">Editar</button><button id="anv-reanalyze" style="${ghostStyle}">Reanalisar foto</button><button id="anv-generate-images" style="${btnStyle}">${commercial.length>=5?'Regenerar imagens':'Gerar imagens'}</button><button id="anv-manage-images" style="${ghostStyle}">Gerenciar imagens</button><button id="anv-delete-product" style="${ghostStyle};color:#b91c1c;border-color:#b91c1c">Excluir produto</button></div>`;
    anchor.parentElement?.insertBefore(div,anchor);
    div.querySelector('#anv-edit-product').onclick=editProduct;
    div.querySelector('#anv-reanalyze').onclick=reanalyzeProduct;
    div.querySelector('#anv-generate-images').onclick=generateImages;
    div.querySelector('#anv-manage-images').onclick=manageImages;
    div.querySelector('#anv-delete-product').onclick=deleteProductUI;
  }

  function scheduleDecorate(){clearTimeout(decorateTimer);decorateTimer=setTimeout(()=>decorateProductPage().catch(()=>{}),80);}
  document.addEventListener('click',e=>{const el=e.target.closest?.('[data-id]');if(el?.dataset?.id)currentProductId=el.dataset.id;},true);
  const observer=new MutationObserver(scheduleDecorate);observer.observe(document.documentElement,{subtree:true,childList:true});
  bindPhoto();scheduleDecorate();
})();