/* Tema claro/escuro das páginas institucionais (Sobre, Contactos,
 * Privacidade). Carrega-se no <head>, sem defer, para pôr data-theme no
 * <html> antes do primeiro desenho e a página não piscar em claro.
 *
 * Quem decide: a escolha feita no botão nesta sessão (sessionStorage
 * `ceme:theme`, a mesma chave do simulador e do assistente), senão o tema do
 * sistema, que se segue se mudar. O botão é o #themeBtn da header; a página
 * chama CEME_THEME.paint() quando muda de língua, para traduzir o rótulo. */
(function (g) {
  var root = document.documentElement;
  var mq = g.matchMedia && g.matchMedia('(prefers-color-scheme: dark)');
  var SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
  function chosen() {
    try { var t = sessionStorage.getItem('ceme:theme'); if (t === 'dark' || t === 'light') return t; } catch (e) {}
    return null;
  }
  function apply() { root.dataset.theme = chosen() || (mq && mq.matches ? 'dark' : 'light'); paint(); }
  function paint() {
    var b = document.getElementById('themeBtn');
    if (!b) return;
    var lang = root.lang === 'en' ? 'en' : 'pt';
    var label = (g.CEME_I18N && g.CEME_I18N.common[lang].theme) || '';
    b.innerHTML = root.dataset.theme === 'dark' ? SUN : MOON;
    b.title = label; b.setAttribute('aria-label', label);
  }
  function toggle() {
    var t = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { sessionStorage.setItem('ceme:theme', t); } catch (e) {}
    apply();
  }
  apply();
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', function () {
    var b = document.getElementById('themeBtn');
    if (b) b.onclick = toggle;
    paint();
  });
  g.CEME_THEME = { paint: paint, toggle: toggle };
})(window);
