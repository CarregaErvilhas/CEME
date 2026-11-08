/* Preferências de acessibilidade, partilhadas por todas as páginas.
 *
 * Carrega-se no <head>, sem defer, para pôr os atributos no <html> antes do
 * primeiro desenho. Guarda em localStorage só o que o utilizador ligou
 * (chaves `ceme:paleta`, `ceme:contraste`, `ceme:texto`: ver /privacidade);
 * sem escolha, segue o sistema (prefers-contrast). O tema claro/escuro é o
 * botão ao lado (theme.js e cada página).
 *
 * A chave e os valores de `ceme:paleta` são os que a página OMIE já usava
 * ('folha' | 'daltonismo'), por isso as duas partilham a escolha. */
(function (g) {
  var root = document.documentElement;
  var KEYS = { paleta: 'ceme:paleta', contraste: 'ceme:contraste', texto: 'ceme:texto' };
  var ON = { paleta: 'daltonismo', contraste: 'mais', texto: 'grande' };
  var OFF = { paleta: 'folha', contraste: 'normal', texto: 'normal' };
  function get(k) { try { return localStorage.getItem(KEYS[k]); } catch (e) { return null; } }
  function put(k, v) { try { localStorage.setItem(KEYS[k], v); } catch (e) {} }
  function mq(q) { try { return g.matchMedia && g.matchMedia(q).matches; } catch (e) { return false; } }
  function value(k) {
    var s = get(k);
    if (s === ON[k] || s === OFF[k]) return s;
    return k === 'contraste' && mq('(prefers-contrast: more)') ? ON[k] : OFF[k];
  }
  function apply() {
    root.dataset.paleta = value('paleta');
    root.dataset.contraste = value('contraste');
    root.dataset.texto = value('texto');
  }
  apply();

  var T = {
    pt: { btn: 'Acessibilidade e cores', title: 'Acessibilidade', cvd: 'Cores para daltonismo', cvdH: 'Azul e laranja no lugar do verde e do vermelho.', hc: 'Contraste elevado', hcH: 'Texto e contornos mais fortes.', big: 'Texto maior', bigH: 'Aumenta tudo cerca de 15%.', reset: 'Repor', close: 'Fechar', skip: 'Saltar para o conteúdo' },
    en: { btn: 'Accessibility and colours', title: 'Accessibility', cvd: 'Colour-blind friendly colours', cvdH: 'Blue and orange instead of green and red.', hc: 'High contrast', hcH: 'Stronger text and outlines.', big: 'Larger text', bigH: 'Scales everything up by about 15%.', reset: 'Reset', close: 'Close', skip: 'Skip to content' }
  };
  function tr() { return T[root.lang === 'en' ? 'en' : 'pt']; }
  var EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';

  var btn, panel, skip;
  function box(k, label, hint) {
    return '<label><input type="checkbox" data-k="' + k + '"' + (value(k) === ON[k] ? ' checked' : '') + '><span>' + label + '<small>' + hint + '</small></span></label>';
  }
  function build() {
    var s = tr();
    var hasOmieToggle = !!document.getElementById('cvd'); // a OMIE tem o seu interruptor
    panel.setAttribute('aria-label', s.title);
    panel.innerHTML = '<h2>' + s.title + '</h2>' + (hasOmieToggle ? '' : box('paleta', s.cvd, s.cvdH)) +
      box('contraste', s.hc, s.hcH) + box('texto', s.big, s.bigH) +
      '<div class="row"><button type="button" data-reset>' + s.reset + '</button><button type="button" data-close>' + s.close + '</button></div>';
  }
  function label() { var s = tr(); btn.title = s.btn; btn.setAttribute('aria-label', s.btn); if (skip) skip.textContent = s.skip; }
  function place() {
    var r = btn.getBoundingClientRect();
    var w = Math.min(320, g.innerWidth - 24);
    panel.style.left = Math.max(12, Math.min(r.left, g.innerWidth - w - 12)) + 'px';
    if (btn.classList.contains('fab')) { panel.style.top = 'auto'; panel.style.bottom = (g.innerHeight - r.top + 8) + 'px'; }
    else { panel.style.bottom = 'auto'; panel.style.top = (r.bottom + 8) + 'px'; }
  }
  function open(on) {
    if (on) { build(); panel.hidden = false; place(); var f = panel.querySelector('input'); if (f) f.focus(); }
    else { panel.hidden = true; }
    btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  }
  function init() {
    // «Saltar para o conteúdo»: primeiro elemento focável da página.
    var main = document.querySelector('main');
    if (main) {
      if (!main.id) main.id = 'main';
      main.setAttribute('tabindex', '-1');
      skip = document.createElement('a');
      skip.className = 'skip'; skip.href = '#' + main.id;
      skip.onclick = function (e) { e.preventDefault(); main.focus(); main.scrollIntoView(); };
      document.body.insertBefore(skip, document.body.firstChild);
    }
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'a11ybtn'; btn.innerHTML = EYE;
    btn.setAttribute('aria-haspopup', 'dialog'); btn.setAttribute('aria-expanded', 'false');
    var theme = document.getElementById('themeBtn');
    if (theme && theme.parentNode) theme.parentNode.insertBefore(btn, theme.nextSibling);
    else { btn.className += ' fab'; document.body.appendChild(btn); }
    panel = document.createElement('div');
    panel.className = 'a11ypanel'; panel.setAttribute('role', 'dialog'); panel.hidden = true;
    document.body.appendChild(panel);
    label();
    btn.onclick = function () { open(panel.hidden); };
    panel.addEventListener('change', function (e) {
      var k = e.target && e.target.dataset && e.target.dataset.k;
      if (!k) return;
      put(k, e.target.checked ? ON[k] : OFF[k]);
      apply();
      // a OMIE redesenha os gráficos quando a paleta muda
      if (k === 'paleta') document.dispatchEvent(new CustomEvent('ceme:paleta'));
    });
    panel.addEventListener('click', function (e) {
      if (e.target.closest('[data-close]')) { open(false); btn.focus(); }
      if (e.target.closest('[data-reset]')) {
        Object.keys(KEYS).forEach(function (k) { try { localStorage.removeItem(KEYS[k]); } catch (x) {} });
        apply(); build(); document.dispatchEvent(new CustomEvent('ceme:paleta'));
      }
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) { open(false); btn.focus(); } });
    document.addEventListener('click', function (e) { if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) open(false); });
    g.addEventListener('resize', function () { if (!panel.hidden) place(); });
    // a língua muda sem recarregar: reler o rótulo
    new MutationObserver(function () { label(); if (!panel.hidden) build(); }).observe(root, { attributes: true, attributeFilter: ['lang'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  g.CEME_A11Y = { apply: apply };
})(window);
