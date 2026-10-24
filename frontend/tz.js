// Horas de relógio numa região — partilhado pelo simulador e pelo assistente.
//
// A hora que o utilizador escreve ("2026/10/25 01:30") é a do relógio da
// REGIÃO do carregamento, não a do browser: um visitante em Londres que
// simula um carregamento nos Açores está a falar das 01:30 dos Açores. E o
// browser só sabe converter o fuso dele (`new Date(y, m, d, h, mi)`), por isso
// a conversão faz-se aqui, com o Intl, nos dois sentidos.
//
// Os dias de mudança de hora (dias de 23 e de 25 horas) são o caso que
// importa: `zoned` resolve uma hora que não existe (a das 01:xx de Março em
// Lisboa) para o instante a seguir ao salto, e uma hora que existe duas
// vezes (a das 01:xx de Outubro) para a primeira passagem — ver tz.test.js.
(function (root) {
  const TZ = { CONT: 'Europe/Lisbon', MAD: 'Atlantic/Madeira', AZO: 'Atlantic/Azores' };

  // As partes de relógio de um instante num fuso.
  function zparts(date, tz) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map(x => [x.type, x.value]));
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
  }

  // O instante de uma hora de relógio num fuso.
  //
  // Os candidatos são a hora lida com o offset de antes e com o de depois de
  // uma eventual mudança (6 h para cada lado chegam: a mudança é de 1 h).
  //   - os dois batem certo e são diferentes: a hora repete-se → a PRIMEIRA
  //     passagem (o instante mais cedo);
  //   - nenhum bate certo: a hora não existe → lê-se com o offset de antes,
  //     o que dá o instante a seguir ao salto (01:30 em Lisboa a 29/03 →
  //     02:30; 00:30 nos Açores a 29/03 → 01:30), no mesmo dia civil.
  function zoned(y, m, d, h, mi, tz) {
    const wall = Date.UTC(y, m - 1, d, h, mi);
    const off = at => { const p = zparts(new Date(at), tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - at; };
    const before = wall - off(wall - 6 * 3600000);
    const after = wall - off(wall + 6 * 3600000);
    const fits = t => { const p = zparts(new Date(t), tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) === wall; };
    const ok = [before, after].filter(fits);
    return new Date(ok.length ? Math.min(...ok) : before);
  }

  const p2 = n => String(n).padStart(2, '0');

  // "aaaa/mm/dd hh:mm" de um instante, no relógio do fuso.
  function toWall(date, tz) {
    const p = zparts(date, tz);
    return `${p.y}/${p2(p.m)}/${p2(p.d)} ${p2(p.h)}:${p2(p.mi)}`;
  }

  // O instante de um "aaaa/mm/dd hh:mm" lido no relógio do fuso (ou null).
  function fromWall(text, tz) {
    const m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/.exec(String(text || '').trim());
    if (!m) return null;
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
    const at = zoned(y, mo, d, h, mi, tz);
    return Number.isNaN(at.getTime()) ? null : at;
  }

  root.CEME_TZ = { TZ, zparts, zoned, toWall, fromWall };
})(typeof window !== 'undefined' ? window : globalThis);
