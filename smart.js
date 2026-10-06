(() => {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  let aiData = null;
  let busy = false;

  function text(v) {
    return v === null || v === undefined ? '' : String(v).trim();
  }

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
      panel.style.cssText = [
        'margin-top:10px', 'padding:12px 14px', 'border:1px solid #e5e7eb',
        'border-radius:11px', 'background:#fafafa', 'font-size:13px',
        'line-height:1.45', 'color:#4b5563'
      ].join(';');
      photo.insertAdjacentElement('afterend', panel);
    }
    return panel;
  }

  function setPanel(html) {
    const photo = document.getElementById('photo');
    if (!photo) return;
    getPanel(photo).innerHTML = html;
  }

  async function imageToDataURL(file) {
    const raw = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    // Mantém leitura de códigos/textos, mas evita mandar fotos enormes para a função.
    try {
      const img = await new Promise((resolve, reject) => {
        const x = new Image();
        x.onload = () => resolve(x);
        x.onerror = reject;
        x.src = raw;
      });
      const maxSide = 1800;
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      if (scale >= 1) return raw;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.9);
    } catch {
      return raw;
    }
  }

  function esc(v) {
    return text(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
    const pending = Array.isArray(data.needs_confirmation) && data.needs_confirmation.length
      ? `<div style="margin-top:8px;color:#92400e"><b>Confirmar:</b> ${esc(data.needs_confirmation.join(' · '))}</div>` : '';
    const warnings = Array.isArray(data.warnings) && data.warnings.length
      ? `<div style="margin-top:6px;color:#991b1b">${esc(data.warnings.join(' · '))}</div>` : '';

    setPanel(`<div style="color:#111;font-weight:800;margin-bottom:5px">IA identificou: ${esc(data.name || data.product_type || 'produto')} · confiança ${conf}%</div>${details || 'Imagem analisada.'}${pending}${warnings}<div style="margin-top:7px;color:#6b7280">Os campos confiáveis foram preenchidos automaticamente. O que a foto não comprova ficou para confirmação.</div>`);
  }

  async function analyze(file) {
    if (!file || busy) return;
    busy = true;
    aiData = null;
    window.__anvAiProduct = null;
    setPanel('<b style="color:#111">Analisando produto pela foto…</b><br>Identificando peça, aplicação e especificações visíveis.');

    try {
      const imageData = await imageToDataURL(file);
      const response = await nativeFetch('/api/ai/analyze-product', {
        method: 'POST',
        credentials: 'include',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ image_data_url: imageData, filename: file.name })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = typeof payload?.detail === 'string' ? payload.detail : (payload?.detail?.message || `Erro ${response.status}`);
        throw new Error(detail);
      }

      aiData = payload;
      window.__anvAiProduct = payload;

      fill('title', payload.name, 0.55, 'name');
      fill('brand', payload.brand, 0.80, 'brand');
      fill('model', payload.model, 0.85, 'model');
      fill('material', payload.material, 0.72, 'material');
      renderResult(payload);
    } catch (error) {
      setPanel(`<span style="color:#991b1b"><b>Análise automática não concluída.</b> ${esc(error?.message || 'Tente novamente.')}</span><br>O cadastro manual continua funcionando normalmente.`);
    } finally {
      busy = false;
    }
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

  // Acrescenta os dados técnicos da IA ao POST original sem mexer no código da tela.
  window.fetch = async function(input, init = {}) {
    try {
      const url = typeof input === 'string' ? input : input?.url || '';
      const method = String(init?.method || 'GET').toUpperCase();
      if (method === 'POST' && /\/api\/products(?:\?|$)/.test(url) && aiData && typeof init.body === 'string') {
        const body = JSON.parse(init.body);
        const f = aiData.field_confidence || {};
        if (aiData.application && Number(f.application || aiData.confidence || 0) >= 0.65) body.application = aiData.application;
        if (aiData.compatibility && Number(f.compatibility || aiData.confidence || 0) >= 0.82) body.compatibility = aiData.compatibility;
        if (aiData.description) body.description = aiData.description;
        if (aiData.technical_details) body.technical_details = aiData.technical_details;
        init = {...init, body: JSON.stringify(body)};
      }
    } catch (_) {}
    return nativeFetch(input, init);
  };

  const observer = new MutationObserver(bindPhoto);
  observer.observe(document.documentElement, {subtree:true, childList:true});
  bindPhoto();
})();
