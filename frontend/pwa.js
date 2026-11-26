/* A CEME como app (PWA): regista o service worker e monta o «Instalar app».
 *
 * O aviso (#install-bar) e o diálogo com os passos (#install-dialog) vão no fim
 * do <body>, com o texto do strings.js nas duas línguas: o CSS (install.css)
 * mostra o da língua do <html>, por isso trocar de língua não obriga a refazer
 * nada. Quem decide o que aparece é o install.js, o mesmo nos sites do grupo:
 * o browser em uso, se a app já está instalada, se o Chrome deixa instalar
 * direto. Os botões «Instalar app» das páginas (rodapé do simulador, ecrãs do
 * assistente) só precisam de `data-install-open`.
 */
(function () {
  'use strict';
  if (window.__CEME_PWA__) return;
  window.__CEME_PWA__ = true;

  // Registo do service worker (sw.js: arranque offline mínimo).
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  const I = window.CEME_I18N && window.CEME_I18N.common;
  if (!I) return;

  // Cada texto nas duas línguas; o CSS esconde a que não é a do <html>.
  const both = (k) => ['pt', 'en'].map((l) => `<span data-l="${l}">${I[l][k]}</span>`).join('');
  const steps = (k, tag = 'ol', cls = 'install-steps') => ['pt', 'en'].map((l) =>
    `<${tag} class="${cls}" data-l="${l}">${I[l][k].map((s) => `<li>${s}</li>`).join('')}</${tag}>`).join('');
  const note = (k) => `<p class="install-note">${both(k)}</p>`;
  const attr = (k) => I.pt[k] + ' / ' + I.en[k];

  const HINTS = {
    'ios-safari': steps('installIosSafari') + note('installIosSafariNote'),
    'ios-other': steps('installIosOther') + note('installIosOtherNote'),
    'in-app': note('installInAppNote') + steps('installInApp') + note('installInAppCopy') +
      ['pt', 'en'].map((l) => `<p class="install-copy" data-l="${l}"><code data-install-url></code> ` +
        `<button class="install-btn" type="button" data-install-copy data-copied="${I[l]['installCopied']}">${I[l]['installCopy']}</button></p>`).join(''),
    'android-firefox': steps('installFirefox'),
    samsung: steps('installSamsung'),
    android: steps('installAndroid') + note('installAndroidNote'),
    desktop: steps('installDesktop', 'ul', 'install-list') + note('installDesktopNote'),
  };

  function mount() {
    // Só nas páginas que carregam o install.js (simulador e assistente).
    if (!document.querySelector('script[src="/install.js"]') || document.getElementById('install-dialog')) return;
    const wrap = document.createElement('div');
    wrap.innerHTML =
      `<div class="install-bar" id="install-bar" data-install-key="ceme:install" hidden>` +
        `<img src="/icon-192.png?v=3" alt="" width="44" height="44">` +
        `<p><strong>${both('installBarTitle')}</strong> <span class="install-sub">${both('installBarText')}</span></p>` +
        `<button class="install-btn primary" type="button" data-install-open>${both('installBarAdd')}</button>` +
        `<button class="install-x" type="button" data-install-dismiss aria-label="${attr('installLater')}">×</button>` +
      `</div>` +
      `<dialog class="install-dlg" id="install-dialog" closedby="any" aria-labelledby="install-title">` +
        `<svg hidden><symbol id="i-share" viewBox="0 0 24 24"><path d="M12 14V3M8 7l4-4 4 4M7 10H5v11h14V10h-2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol></svg>` +
        `<div class="install-tile" aria-hidden="true"><img src="/icon-192.png?v=3" alt="" width="64" height="64"><span>CEME</span></div>` +
        `<h2 id="install-title">${both('installTitle')}</h2>` +
        `<p class="install-lede">${both('installLede')}</p>` +
        Object.entries(HINTS).map(([h, html]) => `<div data-install-hint="${h}" hidden>${html}</div>`).join('') +
        `<p class="install-actions"><button class="install-btn" type="button" data-install-close>${both('installClose')}</button></p>` +
      `</dialog>`;
    while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
  }

  // Antes do install.js, que também espera pelo DOMContentLoaded e é
  // carregado depois deste ficheiro.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
