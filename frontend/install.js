// «Instalar app»: põe o site no ecrã principal, onde abre em ecrã inteiro como
// uma app (PWA). O mesmo ficheiro em todos os sites do grupo (aqui com os
// comentários em português); cada página traz o markup, já na sua língua, e
// este script só decide o que mostrar:
//   [data-install-open]  botões que o abrem (rodapé, aviso); o CSS da página
//                        mostra-os quando o <html> tem data-install="ready"
//   #install-bar         aviso nos telemóveis, data-install-key = chave guardada
//   #install-dialog      os passos, um bloco [data-install-hint] por browser
// Os cliques apanham-se no document, por isso um botão que a página desenhe
// depois (o assistente refaz cada ecrã) também funciona.
//
// Os browsers Chromium (Chrome, Edge, Samsung Internet, Brave, Opera) disparam
// beforeinstallprompt quando o manifest é instalável e a pessoa já usou a
// página um bocado; a partir daí o botão abre o diálogo de instalação do
// próprio browser. Antes disso, e no Safari, em qualquer browser do iOS e no
// Firefox, que não têm esse evento, abre os passos do browser em uso. Os
// browsers dentro de outras apps (Facebook, Instagram, Messenger...) não
// instalam nada: os passos deles dizem para abrir a página no browser.
(function (root) {
  'use strict';

  // Que bloco de passos serve a este browser. Pura, para os testes lhe darem
  // user agents.
  function installHint(ua, touchPoints, brave) {
    ua = ua || '';
    if (/FBAN|FBAV|FB_IAB|FBIOS|Instagram|Messenger|LinkedInApp|MicroMessenger|TikTok|musical_ly|Snapchat|Pinterest|Line\/|GSA\//.test(ua)) return 'in-app';
    // O iPadOS diz que é um Mac; só o ecrã táctil o denuncia.
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) {
      return brave || /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|DuckDuckGo|Ddg\//.test(ua) ? 'ios-other' : 'ios-safari';
    }
    if (/Android/.test(ua)) {
      if (/; wv\)/.test(ua)) return 'in-app'; // WebView de outra app
      if (/SamsungBrowser/.test(ua)) return 'samsung';
      if (/Firefox/.test(ua)) return 'android-firefox';
      return 'android';
    }
    return /Mobi/.test(ua) ? 'android' : 'desktop';
  }

  if (typeof document === 'undefined') { root.installHint = installHint; return; }

  // Já aberta a partir do ecrã principal: nada a oferecer.
  if (matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)').matches || navigator.standalone === true) return;

  var hint = installHint(navigator.userAgent, navigator.maxTouchPoints || 0, !!navigator.brave);
  var SNOOZE = 30 * 864e5; // «Agora não» esconde o aviso 30 dias
  var deferred = null;
  var each = function (sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); };

  function bar() { return document.getElementById('install-bar'); }
  function key() { var b = bar(); return b && b.getAttribute('data-install-key'); }
  // O localStorage pode falhar (modo privado, dados do site bloqueados): aí o
  // aviso simplesmente volta da próxima vez.
  function snoozed() { try { return Date.now() - Number(localStorage.getItem(key()) || 0) < SNOOZE; } catch (e) { return false; } }
  function snooze() { try { if (key()) localStorage.setItem(key(), String(Date.now())); } catch (e) {} }
  function hideBar() { var b = bar(); if (b) b.hidden = true; }

  function installed() {
    deferred = null;
    snooze();
    document.documentElement.setAttribute('data-install', 'done');
    hideBar();
  }

  function showSteps() {
    var d = document.getElementById('install-dialog');
    if (!d) return;
    each('#install-dialog [data-install-hint]', function (b) {
      b.hidden = b.getAttribute('data-install-hint').split(' ').indexOf(hint) < 0;
    });
    each('#install-dialog [data-install-url]', function (u) { u.textContent = location.href; });
    if (!d.open) d.showModal();
  }

  function open() {
    snooze();
    hideBar();
    // A Web Install API, onde existe, é o diálogo do próprio browser. Tem de
    // correr dentro do clique, por isso não se espera por nada antes dela.
    if (typeof navigator.install === 'function') {
      navigator.install().then(installed, function (e) { if (!e || e.name !== 'AbortError') showSteps(); });
      return;
    }
    if (deferred) {
      // Só serve uma vez: larga-se antes de esperar pela resposta.
      var e = deferred;
      deferred = null;
      e.prompt();
      e.userChoice.then(function (c) { if (c && c.outcome === 'accepted') installed(); }, function () {});
      return;
    }
    showSteps();
  }

  addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); // o nosso aviso substitui a mini-infobar do Chrome
    deferred = e;
  });
  addEventListener('appinstalled', installed);

  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-install-open], [data-install-dismiss], [data-install-close], [data-install-copy]');
    if (!b) return;
    if (b.hasAttribute('data-install-open')) open();
    else if (b.hasAttribute('data-install-dismiss')) { snooze(); hideBar(); }
    else if (b.hasAttribute('data-install-close')) { var d = document.getElementById('install-dialog'); if (d) d.close(); }
    else if (navigator.clipboard) {
      navigator.clipboard.writeText(location.href).then(function () {
        b.textContent = b.getAttribute('data-copied') || b.textContent;
      }, function () {});
    }
  });

  function init() {
    document.documentElement.setAttribute('data-install', 'ready');
    // Tocar fora fecha o diálogo: o closedby="any" fá-lo onde é suportado,
    // este clique fá-lo no Safari.
    var d = document.getElementById('install-dialog');
    if (d && !('closedBy' in HTMLDialogElement.prototype)) {
      d.addEventListener('click', function (ev) {
        if (ev.target !== d) return;
        var r = d.getBoundingClientRect();
        if (ev.clientY < r.top || ev.clientY > r.bottom || ev.clientX < r.left || ev.clientX > r.right) d.close();
      });
    }
    // O aviso só em telemóveis e tablets: no computador o Chrome e o Edge
    // mostram o seu ícone de instalar, e o botão do rodapé chega.
    var b = bar();
    if (b && hint !== 'desktop' && !snoozed()) b.hidden = false;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(this);
