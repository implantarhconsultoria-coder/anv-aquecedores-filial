(() => {
  'use strict';

  function text(v){ return v == null ? '' : String(v).trim(); }

  async function fixEditSave(button){
    if (!button || button.dataset.anvPatchBound === '1') return;
    button.dataset.anvPatchBound = '1';
    button.addEventListener('click', async (event) => {
      const modal = button.closest('#anv-smart-modal');
      if (!modal) return;
      event.preventDefault();
      event.stopImmediatePropagation();

      const productTitle = text(document.querySelector('h1')?.textContent);
      let productId = null;
      try {
        const r = await fetch('/api/anv-ops?action=catalog', {credentials:'include'});
        const list = r.ok ? await r.json() : [];
        const matches = Array.isArray(list) ? list.filter(x => text(x.name) === productTitle) : [];
        if (matches.length === 1) productId = matches[0].id;
      } catch (_) {}
      if (!productId) return alert('Produto não identificado para edição.');

      const body = {};
      modal.querySelectorAll('[data-f]').forEach(el => {
        const key = el.dataset.f;
        if (key === 'sale_price') body[key] = Number(el.value || 0);
        else if (key === 'stock' || key === 'minimum_stock') body[key] = Math.max(0, Number(el.value || 0));
        else body[key] = text(el.value) || null;
      });

      button.disabled = true;
      button.textContent = 'Salvando…';
      try {
        const r = await fetch(`/api/products/${encodeURIComponent(productId)}`, {
          method:'PATCH', credentials:'include', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
        });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof out?.detail === 'string' ? out.detail : 'Falha ao salvar alterações');
        location.reload();
      } catch (e) {
        button.disabled = false;
        button.textContent = 'Salvar alterações';
        alert(e.message || 'Falha ao salvar alterações');
      }
    }, true);
  }

  function patchMessages(){
    document.querySelectorAll('.note').forEach(el => {
      const t = text(el.textContent);
      if (t.includes('motor de geração das imagens comerciais ainda precisa ser conectado')) {
        el.innerHTML = '<b>Imagens comerciais pendentes</b><p class="small">Clique em <b>Gerar imagens</b> para criar e salvar o pacote ANV com capa + 4 imagens adicionais.</p>';
      }
    });
  }

  function bind(){
    fixEditSave(document.getElementById('anv-save-edit'));
    patchMessages();
  }

  new MutationObserver(bind).observe(document.documentElement,{subtree:true,childList:true});
  bind();
})();