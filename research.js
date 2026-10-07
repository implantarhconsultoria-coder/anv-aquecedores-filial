(() => {
  'use strict';

  const previousFetch = window.fetch.bind(window);
  const STORAGE_KEY = 'anv-image-research-v2';
  const STORAGE_TTL_MS = 12 * 60 * 60 * 1000;
  const PROGRESS_KEY = 'anv-image-progress-v1';
  const PROGRESS_TTL_MS = 30 * 60 * 1000;
  let currentResearch = null;
  let observedResult = window.__anvAiProduct || null;
  let lastPhotoDataUrl = null;
  let stageTimers = [];
  let persistencePromise = null;
  let persistenceKey = null;

  const txt = v => v === null || v === undefined ? '' : String(v).trim();
  const esc = v => txt(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const norm = v => txt(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const compact = v => txt(v).toLowerCase().replace(/[^a-z0-9]/g, '');

  function researchFingerprint(research) {
    return txt(research?.image_hash) || txt(research?.source_url) || [research?.gtin, research?.code, research?.sku, research?.brand, research?.model].map(compact).filter(Boolean).join('|') || 'current';
  }

  function saveResearchState(research) {
    if (!research) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ saved_at: Date.now(), research }));
    } catch (_) {}
  }

  function clearResearchState() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  function loadResearchState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!raw?.research || !Number(raw.saved_at) || Date.now() - Number(raw.saved_at) > STORAGE_TTL_MS) {
        clearResearchState();
        return null;
      }
      return raw.research;
    } catch (_) {
      clearResearchState();
      return null;
    }
  }

  function photoPanel() {
    const photo = document.getElementById('photo');
    if (!photo) return null;
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
    const p = photoPanel();
    if (p) p.innerHTML = html;
  }

  function setPersistenceStatus(message, tone = '#166534') {
    const el = document.getElementById('anv-research-persist-state');
    if (el) {
      el.style.color = tone;
      el.textContent = message;
    }
  }

  function clearStages() {
    for (const timer of stageTimers) clearTimeout(timer);
    stageTimers = [];
  }

  function saveProgress(stage, detail = '', tone = 'normal') {
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify({ stage, detail, tone, updated_at: Date.now() })); } catch (_) {}
  }

  function loadProgress() {
    try {
      const raw = JSON.parse(localStorage.getItem(PROGRESS_KEY) || 'null');
      if (!raw || !Number(raw.updated_at) || Date.now() - Number(raw.updated_at) > PROGRESS_TTL_MS) return null;
      return raw;
    } catch { return null; }
  }

  function updateProgress(stage, detail = '', tone = 'normal') {
    clearStages();
    saveProgress(stage, detail, tone);
    const color = tone === 'error' ? '#991b1b' : tone === 'ok' ? '#166534' : '#111';
    setPanel(`<b style="color:${color}">${esc(stage)}</b>${detail ? `<br>${esc(detail)}` : ''}`);
  }

  window.__anvResearchProgress = updateProgress;

  function startStages() {
    updateProgress('Lendo a foto', 'Preparando a imagem para iniciar a identificação.');
  }

  function applyToForm(data) {
    const map = [
      ['title', data.name], ['brand', data.brand], ['model', data.model], ['material', data.material],
      ['code', data.code], ['sku', data.sku], ['gtin', data.gtin]
    ];
    for (const [id, value] of map) {
      const el = document.getElementById(id);
      if (!el || !txt(value)) continue;
      if (!txt(el.value) || ['title','brand','model','material'].includes(id)) {
        el.value = txt(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  function renderResearch(data) {
    clearStages();
    const p = photoPanel();
    if (!p) return;
    if (data?.research_status === 'CONFIRMADO') {
      const conf = Math.round(Number(data.match_confidence || data.confidence || 0) * 100);
      const source = txt(data.source_url);
      const evidence = Array.isArray(data.evidence) ? data.evidence.slice(0, 4) : [];
      const images = Array.isArray(data.image_urls) ? data.image_urls.filter(Boolean) : [];
      const productSaved = !!data.catalog_persisted || !!data.existing_product_id;
      p.innerHTML = `
        <div style="font-weight:800;color:#111;margin-bottom:6px">Produto identificado</div>
        <div><b>${esc(data.name || 'Produto')}</b>${data.brand || data.model ? ` · ${esc([data.brand,data.model].filter(Boolean).join(' · '))}` : ''}</div>
        <div style="margin-top:6px"><b>Correspondência:</b> ${esc(data.match_level || 'confirmada')} · ${conf}%</div>
        ${data.code || data.part_number || data.gtin ? `<div style="margin-top:4px"><b>Identificador:</b> ${esc(data.gtin || data.part_number || data.code)}</div>` : ''}
        ${source ? `<div style="margin-top:6px"><b>Fonte encontrada:</b> <a href="${esc(source)}" target="_blank" rel="noopener noreferrer" style="word-break:break-all">${esc(data.source_domain || source)}</a></div>` : ''}
        ${evidence.length ? `<div style="margin-top:6px"><b>Evidências:</b> ${esc(evidence.join(' · '))}</div>` : ''}
        ${images.length ? `<div style="margin-top:6px;color:#6b7280">${images.length} imagem(ns) correspondente(s) localizada(s) para validação/importação.</div>` : ''}
        <div id="anv-research-persist-state" style="margin-top:8px;color:#166534;font-weight:700">${productSaved ? 'Produto vinculado ao catálogo ANV. Preparando anúncio.' : 'Produto identificado. Salvando no catálogo ANV e preparando anúncio.'}</div>`;
      applyToForm(data);
      return;
    }

    const candidates = Array.isArray(data?.candidates) ? data.candidates.slice(0, 6) : [];
    p.innerHTML = `
      <div style="font-weight:800;color:#991b1b;margin-bottom:6px">Não foi possível confirmar este produto automaticamente</div>
      <div style="margin-bottom:8px">O sistema não vai cadastrar um produto parecido apenas para continuar.</div>
      ${candidates.length ? `<div style="font-weight:700;color:#111;margin:8px 0 5px">Candidatos encontrados</div>${candidates.map((c,i) => `
        <div style="border-top:1px solid #e5e7eb;padding:8px 0">
          <div><b>${esc(c.title || c.name || c.domain || `Candidato ${i+1}`)}</b></div>
          <div style="font-size:12px;color:#6b7280;word-break:break-all">${esc(c.domain || c.url || '')}</div>
          ${(c.evidence || []).length ? `<div style="font-size:12px;margin-top:3px">${esc(c.evidence.slice(0,2).join(' · '))}</div>` : ''}
          ${(c.conflicts || []).length ? `<div style="font-size:12px;margin-top:3px;color:#991b1b">${esc(c.conflicts.slice(0,2).join(' · '))}</div>` : ''}
          <button type="button" data-anv-candidate="${i}" style="margin-top:6px;padding:6px 9px;border:1px solid #d1d5db;border-radius:8px;background:#fff;cursor:pointer">Validar este resultado</button>
        </div>`).join('')}` : '<div style="color:#6b7280">Nenhum candidato confiável foi localizado.</div>'}
      <div style="margin-top:10px;border-top:1px solid #e5e7eb;padding-top:9px">
        <div style="font-weight:700;color:#111;margin-bottom:5px">Alternativa manual, somente se necessário</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <input id="anv-manual-source-url" type="url" placeholder="https://..." style="flex:1;min-width:220px;padding:7px 8px;border:1px solid #d1d5db;border-radius:8px">
          <button id="anv-manual-source-btn" type="button" style="padding:7px 10px;border:1px solid #d1d5db;border-radius:8px;background:#fff;cursor:pointer">Validar URL</button>
        </div>
      </div>`;

    p.querySelectorAll('[data-anv-candidate]').forEach(btn => btn.addEventListener('click', async () => {
      const c = candidates[Number(btn.dataset.anvCandidate)];
      if (c?.url) await validateManualUrl(c.url);
    }));
    const manualBtn = document.getElementById('anv-manual-source-btn');
    if (manualBtn) manualBtn.addEventListener('click', async () => {
      const input = document.getElementById('anv-manual-source-url');
      if (txt(input?.value)) await validateManualUrl(input.value);
    });
  }

  async function handleResearchResult(data) {
    if (!data) return;
    currentResearch = data;
    observedResult = data;
    window.__anvAiProduct = data;
    saveResearchState(data);
    renderResearch(data);
    if (data.research_status === 'CONFIRMADO') {
      saveProgress('Produto encontrado', `${data.name || 'Produto'} · correspondência ${data.match_level || 'confirmada'}.`, 'ok');
      try { await ensureProductPersisted(data); }
      catch (e) { setPersistenceStatus(`Produto identificado, mas a gravação automática falhou: ${e?.message || 'erro desconhecido'}. O botão Salvar continua disponível.`, '#991b1b'); }
    }
  }

  async function validateManualUrl(url) {
    setPanel('<b style="color:#111">Validando fonte informada</b><br>Comparando a página com os identificadores do produto.');
    try {
      const r = await previousFetch('/api/ai/analyze-product', {
        method: 'POST', credentials: 'include', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ manual_url: url, clues: currentResearch?.identifiers || {} })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : (data?.detail?.message || `Erro ${r.status}`));
      await handleResearchResult(data);
    } catch (e) {
      setPanel(`<span style="color:#991b1b"><b>Não foi possível validar essa URL.</b> ${esc(e?.message || 'Verifique a fonte.')}</span>`);
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src;
    });
  }

  async function fileToDataUrl(file) {
    const raw = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file);
    });
    try {
      const img = await loadImage(raw);
      const maxSide = 1600; const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      if (scale >= 1 && String(raw).length < 3_500_000) return raw;
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(img.width * scale)); canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.88);
    } catch { return raw; }
  }

  function bindPhotoCapture() {
    const photo = document.getElementById('photo');
    if (!photo) return;
    if (photo.dataset.anvResearchBound !== '1') {
      photo.dataset.anvResearchBound = '1';
      photo.addEventListener('change', async () => {
        const file = photo.files?.[0];
        currentResearch = null;
        observedResult = null;
        lastPhotoDataUrl = null;
        persistencePromise = null;
        persistenceKey = null;
        clearResearchState();
        if (!file) return;
        startStages();
        try { lastPhotoDataUrl = await fileToDataUrl(file); } catch {}
      }, true);
    }
    if (photo.dataset.anvResearchRestored !== '1' && !currentResearch && !photo.files?.length) {
      photo.dataset.anvResearchRestored = '1';
      const restored = loadResearchState();
      if (restored) handleResearchResult(restored).catch(() => {});
      else {
        const progress = loadProgress();
        if (progress) updateProgress(progress.stage, progress.detail, progress.tone);
      }
    }
  }

  function mergeResearchIntoProduct(body, research) {
    const out = { ...body };
    if (!research || research.research_status !== 'CONFIRMADO') return out;
    const values = {
      name: research.name, code: research.code || research.part_number, sku: research.sku, gtin: research.gtin,
      brand: research.brand, model: research.model, material: research.material, application: research.application,
      compatibility: research.compatibility, description: research.description, technical_details: research.technical_details
    };
    for (const [k, v] of Object.entries(values)) if (txt(v) && !txt(out[k])) out[k] = v;
    return out;
  }

  function technicalProductBody(research) {
    const body = mergeResearchIntoProduct({ name: research?.name || research?.product_type || 'Produto identificado' }, research);
    for (const key of ['cost_price','sale_price','minimum_price','stock','minimum_stock','price','qty','external_price','external_stock']) delete body[key];
    return body;
  }

  async function catalog() {
    const r = await previousFetch('/api/anv-ops?action=catalog', { credentials: 'include' });
    if (!r.ok) return [];
    return await r.json().catch(() => []);
  }

  function findDuplicate(products, body, research) {
    const explicit = txt(research?.existing_product_id);
    if (explicit) {
      const found = products.find(p => String(p.id) === explicit);
      if (found) return found;
    }
    const gtin = compact(body.gtin || research?.gtin);
    if (gtin) {
      const found = products.find(p => compact(p.gtin) === gtin);
      if (found) return found;
    }
    const codes = [body.code, body.sku, research?.code, research?.sku, research?.part_number].map(compact).filter(x => x.length >= 3);
    if (codes.length) {
      const found = products.find(p => [p.code,p.sku].map(compact).some(x => x && codes.includes(x)));
      if (found) return found;
    }
    const brand = norm(body.brand || research?.brand), model = norm(body.model || research?.model);
    if (brand && model && model.length >= 3) return products.find(p => norm(p.brand) === brand && norm(p.model) === model) || null;
    return null;
  }

  async function ops(body) {
    const r = await previousFetch('/api/anv-ops', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof d?.detail === 'string' ? d.detail : `Erro ${r.status}`);
    return d;
  }

  function canImportSourceImages(research) {
    if (!research?.source_url) return false;
    const source = (research.candidates || []).find(c => c.url === research.source_url || (c.domain && c.domain === research.source_domain));
    const type = String(source?.source_type || '').toLowerCase();
    return ['manufacturer','official_catalog','authorized_distributor','technical_reseller','specialized_store','ecommerce'].includes(type);
  }

  async function saveOriginalImageIfNeeded(productId, research) {
    if (!productId || !lastPhotoDataUrl) return;
    try {
      const products = await catalog();
      const product = products.find(p => String(p.id) === String(productId));
      const exists = (product?.images || []).some(img => {
        if (typeof img === 'string') return img === lastPhotoDataUrl;
        return (research?.image_hash && txt(img?.generation_prompt_hash) === txt(research.image_hash)) || img?.url === lastPhotoDataUrl;
      });
      if (exists) return;
    } catch (_) {}
    try {
      await ops({
        action:'save_image', product_id:productId, url:lastPhotoDataUrl, kind:'source', position:99,
        is_main:false, mime:'image/jpeg', generation_prompt_hash:research?.image_hash || null
      });
    } catch (_) {}
  }

  async function persistResearch(productId, research, saveOriginal = false) {
    if (!productId || !research) return;
    if (saveOriginal) await saveOriginalImageIfNeeded(productId, research);
    try {
      await ops({
        action:'save_research', product_id:productId, source_url:research.source_url, source_domain:research.source_domain,
        source_title:research.source_title, research_status:research.research_status, match_level:research.match_level,
        match_confidence:research.match_confidence, confidence:research.confidence, evidence:research.evidence,
        identifiers:research.identifiers, image_hash:research.image_hash, image_urls:research.image_urls,
        candidates:research.candidates, search_queries:research.search_queries, web_search_model:research.web_search_model,
        cached:research.cached, researched_at:research.researched_at
      });
    } catch (_) {}

    if (research.research_status === 'CONFIRMADO' && canImportSourceImages(research)) {
      const urls = Array.from(new Set((research.image_urls || []).filter(u => /^https?:\/\//i.test(u)))).slice(0, 3);
      await Promise.allSettled(urls.map((url, i) => ops({ action:'import_remote_image', product_id:productId, url, position:20+i })));
    }
  }

  async function runPreflight(productId, research = null) {
    if (!productId) return null;
    const mlRef = research?.marketplace_reference || null;
    const categoryId = txt(mlRef?.category_id) || null;
    const attributes = mlRef?.attributes && typeof mlRef.attributes === 'object' ? mlRef.attributes : {};
    const r = await previousFetch('/api/marketplace/preflight', {
      method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ product_id:productId, category_id:categoryId, attributes, images:[] })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ready:false, blockers:[typeof data?.detail === 'string' ? data.detail : (data?.detail?.message || `Pré-validação indisponível (${r.status})`)] };
    return data;
  }

  async function ensureProductPersisted(research) {
    if (!research || research.research_status !== 'CONFIRMADO') return null;
    if (research.catalog_persisted && research.existing_product_id) {
      setPersistenceStatus(research.preflight?.ready ? 'PRONTO PARA PUBLICAR' : 'Produto salvo no catálogo ANV. Continue com os dados comerciais e a preparação do anúncio.');
      return research.existing_product_id;
    }
    const key = researchFingerprint(research);
    if (persistencePromise && persistenceKey === key) return persistencePromise;
    persistenceKey = key;
    persistencePromise = (async () => {
      updateProgress('Verificando cadastro ANV', 'Conferindo EAN, código, SKU, part number e marca + modelo para evitar duplicidade.');
      const body = technicalProductBody(research);
      const products = await catalog();
      const duplicate = findDuplicate(products, body, research);
      let productId = duplicate?.id || null;
      let action = duplicate?.id ? 'updated' : 'created';

      if (duplicate?.id) {
        const patchBody = { ...body };
        delete patchBody.id; delete patchBody.created_at; delete patchBody.updated_at; delete patchBody.images; delete patchBody.listing;
        const response = await previousFetch(`/api/products/${encodeURIComponent(duplicate.id)}`, {
          method:'PATCH', credentials:'include', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patchBody)
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(typeof data?.detail === 'string' ? data.detail : `Falha ao atualizar produto (${response.status})`);
        }
      } else {
        const response = await previousFetch('/api/products', {
          method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
        });
        const saved = await response.json().catch(() => ({}));
        if (!response.ok || !saved?.id) throw new Error(typeof saved?.detail === 'string' ? saved.detail : `Falha ao criar produto (${response.status})`);
        productId = saved.id;
      }

      research.existing_product_id = productId;
      research.catalog_persisted = true;
      research.product_action = action;
      updateProgress('Buscando imagens', 'Preservando a foto original e importando somente imagens permitidas do produto confirmado.');
      await persistResearch(productId, research, true);

      updateProgress('Preparando anúncio', 'Consultando categoria, atributos obrigatórios e preflight do Mercado Livre.');
      const preflight = await runPreflight(productId, research).catch(e => ({ ready:false, blockers:[e?.message || 'Pré-validação indisponível'] }));
      research.preflight = preflight;
      research.preflight_ready = !!preflight?.ready;
      saveResearchState(research);
      window.__anvAiProduct = research;
      currentResearch = research;

      renderResearch(research);
      if (preflight?.ready) {
        setPersistenceStatus('Pronto para revisar/publicar');
        saveProgress('Pronto para revisar/publicar', 'Produto confirmado, salvo e aprovado no preflight.', 'ok');
      } else {
        const blocker = Array.isArray(preflight?.blockers) && preflight.blockers.length ? ` Pendência: ${preflight.blockers[0]}` : '';
        setPersistenceStatus(`Produto ${action === 'created' ? 'criado' : 'atualizado'} no catálogo ANV. Pré-validação concluída.${blocker}`);
        saveProgress('Preparando anúncio', `Pré-validação concluída.${blocker}`, blocker ? 'error' : 'normal');
      }
      return productId;
    })().finally(() => {
      persistencePromise = null;
    });
    return persistencePromise;
  }

  window.fetch = async function(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const method = String(init?.method || 'GET').toUpperCase();
    if (method === 'POST' && /\/api\/products(?:\?|$)/.test(url) && typeof init.body === 'string' && currentResearch) {
      let body;
      try { body = JSON.parse(init.body); } catch { return previousFetch(input, init); }
      body = mergeResearchIntoProduct(body, currentResearch);
      let duplicate = null;
      try { duplicate = findDuplicate(await catalog(), body, currentResearch); } catch (_) {}
      if (duplicate?.id) {
        const patchBody = { ...body };
        delete patchBody.id; delete patchBody.created_at; delete patchBody.updated_at; delete patchBody.images; delete patchBody.listing;
        const response = await previousFetch(`/api/products/${encodeURIComponent(duplicate.id)}`, {
          method:'PATCH', credentials:'include', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patchBody)
        });
        if (response.ok) {
          currentResearch.existing_product_id = duplicate.id;
          currentResearch.catalog_persisted = true;
          await persistResearch(duplicate.id, currentResearch, true);
          saveResearchState(currentResearch);
        }
        return response;
      }
      const response = await previousFetch(input, { ...init, body: JSON.stringify(body) });
      if (response.ok) {
        try {
          const saved = await response.clone().json();
          if (saved?.id) {
            currentResearch.existing_product_id = saved.id;
            currentResearch.catalog_persisted = true;
            await persistResearch(saved.id, currentResearch, true);
            saveResearchState(currentResearch);
          }
        } catch (_) {}
      }
      return response;
    }
    return previousFetch(input, init);
  };

  setInterval(() => {
    bindPhotoCapture();
    const result = window.__anvAiProduct;
    if (result && result !== observedResult) {
      handleResearchResult(result).catch(() => {});
    }
  }, 350);
})();