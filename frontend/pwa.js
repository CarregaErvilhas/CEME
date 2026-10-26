/* Gatilho de instalação da CEME como app (PWA).
 *
 * O browser dispara `beforeinstallprompt` quando a página cumpre os critérios
 * de instalabilidade (manifest + service worker + HTTPS). Aqui capturamo-lo e
 * mostramos um banner com um botão "Instalar"; ao clicar, chamamos prompt()
 * do evento guardado. No iOS (sem beforeinstallprompt) mostramos instruções
 * para "Adicionar ao ecrã principal".
 */
(function () {
  'use strict';
  if (window.__CEME_PWA__) return;
  window.__CEME_PWA__ = true;

  const lang = (window.__LANG__ === 'en') ? 'en' : 'pt';
  const T = {
    pt: {
      title: 'Instalar a CEME',
      body: 'Adiciona ao ecrã principal para abrir como app.',
      install: 'Instalar',
      dismiss: 'Agora não',
      ios: 'No Safari: toca em Partilhar → "Adicionar ao ecrã principal".',
      manual: 'No menu do browser (⋮), escolhe "Instalar app" ou "Adicionar ao ecrã principal".',
    },
    en: {
      title: 'Install CEME',
      body: 'Add to your home screen to open as an app.',
      install: 'Install',
      dismiss: 'Not now',
      ios: 'In Safari: tap Share → "Add to Home Screen".',
      manual: 'In the browser menu (⋮), choose "Install app" or "Add to Home screen".',
    },
  }[lang];

  let deferredPrompt = null;
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  // "Agora não" lembra-se 7 dias (localStorage pode falhar: modo privado, etc.).
  const DISMISS_KEY = 'ceme-install-dismissed';
  function dismissed() {
    try { return Date.now() - Number(localStorage.getItem(DISMISS_KEY)) < 7 * 864e5; } catch (e) { return false; }
  }
  function rememberDismiss() {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) {}
  }

  function hideBanner() {
    const el = document.getElementById('ceme-install');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function showBanner(opts) {
    if (isStandalone || dismissed()) return;
    if (document.getElementById('ceme-install')) return;
    const el = document.createElement('div');
    el.id = 'ceme-install';
    el.setAttribute('role', 'dialog');
    el.style.cssText =
      'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));' +
      'z-index:9999;display:flex;align-items:center;gap:10px;padding:12px 14px;' +
      'border:1px solid #B9B9B9;border-radius:8px;background:#FBFBFB;color:#1E1E1E;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.12);font:500 14px/1.4 system-ui,-apple-system,sans-serif;';
    el.innerHTML =
      '<div style="flex:1;min-width:0">' +
        '<div style="font-weight:600">' + T.title + '</div>' +
        '<div style="font-size:13px;color:#6F6F6F">' + (opts && opts.ios ? T.ios : opts && opts.manual ? T.manual : T.body) + '</div>' +
      '</div>' +
      (opts && (opts.ios || opts.manual) ? '' :
        '<button id="ceme-install-btn" style="height:36px;padding:0 14px;border:1px solid #1E1E1E;border-radius:6px;background:#FBFBFB;color:#1E1E1E;font:inherit;cursor:pointer">' + T.install + '</button>') +
      '<button id="ceme-install-dismiss" aria-label="' + T.dismiss + '" style="border:0;background:none;font-size:20px;line-height:1;color:#6F6F6F;cursor:pointer;padding:0 4px">×</button>';
    document.body.appendChild(el);
    const btn = document.getElementById('ceme-install-btn');
    if (btn) {
      btn.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        try { deferredPrompt.prompt(); } catch (e) {}
        try { await deferredPrompt.userChoice; } catch (e) {}
        deferredPrompt = null;
        hideBanner();
      });
    }
    const dismiss = document.getElementById('ceme-install-dismiss');
    if (dismiss) dismiss.addEventListener('click', () => { rememberDismiss(); hideBanner(); });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    hideBanner(); // substitui as instruções manuais, se já estavam visíveis
    if (!isStandalone) showBanner();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hideBanner();
  });

  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  // iOS Safari não dispara beforeinstallprompt: mostra instruções manuais.
  // iPadOS 13+ apresenta-se como Mac, daí o teste de ecrã táctil.
  const isIOS = (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) && !window.MSStream;
  if (isIOS && !isStandalone) {
    whenReady(() => showBanner({ ios: true }));
  } else if (!isStandalone && /Android|Mobi/i.test(navigator.userAgent)) {
    // Android: o Chrome só dispara o evento se quiser (já instalada, recusada há
    // pouco, Firefox/Samsung que nem o têm). Sem evento ao fim de uns segundos,
    // mostra instruções manuais em vez de ficar calado.
    window.addEventListener('load', () => {
      setTimeout(() => { if (!deferredPrompt) showBanner({ manual: true }); }, 4000);
    });
  }

  // Registo do service worker (necessário para a instalabilidade).
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
})();