(() => {
  'use strict';

  const access = { user: null, locked: false, loaded: false };
  const ACTION_RE = /(salvar|publicar|preparar anúncio|preparar|editar|reanalisar|gerar|excluir|remover|conectar|separar|embalar|pronto para envio|marcar|revalidar|adicionar|enviar|confirmar|capa|atualizar)/i;
  const SAFE_RE = /^(ir para|voltar|fechar|cancelar|sair|painel|produtos|cadastrar|pedidos|conta|detalhes|abrir)/i;

  function text(v){ return v == null ? '' : String(v).trim(); }

  function ensureStyle(){
    if (document.getElementById('anv-access-style')) return;
    const s = document.createElement('style');
    s.id = 'anv-access-style';
    s.textContent = `
      .anv-access-banner{margin:0 16px 8px;padding:9px 12px;border-radius:10px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-size:12px;font-weight:700}
      .anv-locked-action{position:relative;opacity:.82}
      .anv-lock-icon{display:inline-block;margin-right:6px;font-size:.92em}
      #anv-access-modal{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100000;display:grid;place-items:center;padding:18px}
      #anv-access-modal>div{width:min(420px,94vw);background:#fff;border-radius:18px;padding:24px;text-align:center;box-shadow:0 24px 80px rgba(0,0,0,.28)}
      #anv-access-modal .lock{font-size:36px;margin-bottom:8px}
      #anv-access-modal h3{margin:4px 0 8px;font-size:20px}
      #anv-access-modal p{margin:0 0 16px;color:#666;line-height:1.45}
      #anv-access-modal button{border:0;border-radius:10px;padding:11px 18px;background:#111;color:#fff;font-weight:800}
    `;
    document.head.appendChild(s);
  }

  function showLocked(){
    document.getElementById('anv-access-modal')?.remove();
    const d = document.createElement('div');
    d.id = 'anv-access-modal';
    d.innerHTML = `<div><div class="lock">🔒</div><h3>Aguardando liberação do sistema</h3><p>Seu acesso de demonstração está ativo. As funções operacionais serão disponibilizadas após a liberação de uso.</p><button type="button">Entendi</button></div>`;
    document.body.appendChild(d);
    d.querySelector('button').onclick = () => d.remove();
    d.addEventListener('click', e => { if (e.target === d) d.remove(); });
  }

  function isAction(el){
    if (!el) return false;
    if (el.dataset?.tab) return false;
    const label = text(el.textContent || el.value || el.getAttribute?.('aria-label'));
    if (!label || SAFE_RE.test(label)) return false;
    if (ACTION_RE.test(label)) return true;
    const id = text(el.id);
    return /(save|pub|prepare|edit|delete|remove|generate|connect|reval|confirm)/i.test(id);
  }

  function clearDecoration(){
    document.querySelector('.anv-access-banner')?.remove();
    document.querySelectorAll('.anv-locked-action').forEach(el => {
      el.classList.remove('anv-locked-action');
      delete el.dataset.anvLockedVisual;
      el.querySelector?.('.anv-lock-icon')?.remove();
      if (el.tagName === 'INPUT' && text(el.value).startsWith('🔒 ')) el.value = text(el.value).slice(3);
    });
  }

  function decorate(){
    if (!access.locked) return;
    ensureStyle();

    if (!document.querySelector('.anv-access-banner')) {
      const header = document.querySelector('header.app') || document.querySelector('header');
      if (header) {
        const banner = document.createElement('div');
        banner.className = 'anv-access-banner';
        banner.textContent = '🔒 Acesso de demonstração · aguardando liberação do sistema';
        header.insertAdjacentElement('afterend', banner);
      }
    }

    document.querySelectorAll('button,.btn,input[type="submit"],input[type="button"]').forEach(el => {
      if (!isAction(el) || el.dataset.anvLockedVisual === '1') return;
      el.dataset.anvLockedVisual = '1';
      el.classList.add('anv-locked-action');
      if (el.tagName === 'BUTTON' && !el.querySelector('.anv-lock-icon')) {
        const span = document.createElement('span');
        span.className = 'anv-lock-icon';
        span.textContent = '🔒';
        el.prepend(span);
      } else if (el.tagName === 'INPUT') {
        const val = text(el.value);
        if (val && !val.startsWith('🔒')) el.value = `🔒 ${val}`;
      }
    });
  }

  function applyUser(user){
    const wasLocked = access.locked;
    access.user = user || null;
    access.locked = !!access.user && access.user.role !== 'owner' && access.user.access_status !== 'LIBERADO';
    access.loaded = true;
    window.__anvAccess = access;
    if (access.locked) decorate();
    else if (wasLocked) clearDecoration();
  }

  async function loadAccess(){
    try {
      const r = await fetch('/api/auth/me', { credentials:'include' });
      if (!r.ok) return;
      const data = await r.json();
      applyUser(data?.user || null);
    } catch (_) {}
  }

  document.addEventListener('click', e => {
    if (!access.locked) return;
    const el = e.target.closest?.('button,.btn,input[type="submit"],input[type="button"]');
    if (!isAction(el)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    showLocked();
  }, true);

  document.addEventListener('submit', e => {
    if (!access.locked) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    showLocked();
  }, true);

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const method = String(init?.method || 'GET').toUpperCase();

    if (access.locked && !['GET','HEAD','OPTIONS'].includes(method) && !/\/api\/auth\/(login|logout)/.test(url)) {
      showLocked();
      return new Response(JSON.stringify({detail:'Aguardando liberação do sistema', access_status:access.user?.access_status || 'AGUARDANDO_LIBERACAO'}), {status:423, headers:{'Content-Type':'application/json'}});
    }

    const response = await nativeFetch(input, init);

    if (/\/api\/auth\/login(?:\?|$)/.test(url) && method === 'POST' && response.ok) {
      try {
        const data = await response.clone().json();
        applyUser(data?.user || null);
      } catch (_) {}
    } else if (/\/api\/auth\/logout(?:\?|$)/.test(url) && method === 'POST' && response.ok) {
      const wasLocked = access.locked;
      access.user = null;
      access.locked = false;
      access.loaded = false;
      window.__anvAccess = access;
      if (wasLocked) clearDecoration();
    } else if (/\/api\/auth\/me(?:\?|$)/.test(url) && method === 'GET' && response.ok) {
      try {
        const data = await response.clone().json();
        applyUser(data?.user || null);
      } catch (_) {}
    }

    return response;
  };

  new MutationObserver(() => {
    if (access.loaded && access.locked) decorate();
  }).observe(document.documentElement,{subtree:true,childList:true});

  loadAccess();
})();
