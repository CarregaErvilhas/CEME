// O OMIE de um carregamento, para quem o cobra pela média da sessão.
//
// Num indexado, a conta que parece óbvia é cobrar cada kWh ao OMIE do quarto
// de hora em que ele entrou na bateria (a "curva de carga"): é o que o
// quoteOne faz com um `profile`. Mas nem todos os CEMEs facturam assim. A
// LUZiGÁS, por exemplo, não olha para a curva: pega no preço OMIE de cada
// hora em que o carro esteve ligado, do início ao fim da sessão, faz a média
// simples dessas horas (todas pesam igual, carregue o carro muito, pouco ou
// nada nelas) e aplica esse OMIE a todos os kWh. Ficar ligado depois de a
// bateria encher mexe no preço: as horas paradas também entram na média.
// Que tarifários cobram assim diz o seed (`billing` em VERSIONS).
//
// O preço de uma hora é a média dos seus quatro quartos de hora do OMIE (o
// mercado passou a quartos de hora; o "preço horário" é essa média).
// Os fusos de Portugal (Lisboa, Madeira, Açores) estão desviados de UTC por
// horas inteiras, por isso uma hora UTC é uma hora do relógio em todos eles.
import { lossAt } from './losses.js';

export const HOUR_MS = 3600000;
export const QUARTER_MS = 15 * 60000;

// As horas (início, em ms UTC) que um carregamento toca: da hora do primeiro
// instante à hora do último, todas as do meio incluídas. `from` e `last` são
// o início da primeira e da última fatia do profile (a última acaba dentro
// do seu quarto de hora, por isso a hora dela é a hora do fim).
export function sessionHours(from, last) {
  const a = Math.floor(from.getTime() / HOUR_MS) * HOUR_MS;
  const b = Math.floor(last.getTime() / HOUR_MS) * HOUR_MS;
  const out = [];
  for (let h = a; h <= b; h += HOUR_MS) out.push(h);
  return out;
}

// Os quartos de hora (início, ms UTC) dessas horas, por ordem.
export const hourQuarters = (hours) => hours.flatMap(h => [0, 1, 2, 3].map(i => h + i * QUARTER_MS));

// O OMIE médio da sessão (€/kWh): a média simples dos preços horários.
//   hours:  o resultado de sessionHours
//   omieOf: quarto (ms UTC) → OMIE desse quarto em €/kWh, ou null
// Devolve { omieKwh, hours, from, to } (to exclusivo), ou null se faltar o
// OMIE de algum quarto: com uma hora a meio não se sabe o preço dela, e
// inventá-lo dava um total que o CEME não cobra. Quem chama fica pela curva.
export function sessionOmie(hours, omieOf) {
  if (!hours.length) return null;
  let sum = 0;
  for (const h of hours) {
    const qs = hourQuarters([h]).map(omieOf);
    if (qs.some(v => !Number.isFinite(v))) return null;
    sum += qs.reduce((a, v) => a + v, 0) / 4;
  }
  return {
    omieKwh: sum / hours.length,
    hours: hours.length,
    from: new Date(hours[0]).toISOString(),
    to: new Date(hours.at(-1) + HOUR_MS).toISOString(),
  };
}

// As perdas médias (fracção) nos quartos de hora dessas mesmas horas, para a
// conta usar um só valor, como o OMIE. null se faltar o perfil de perdas.
export function sessionLoss(voltage, s) {
  const t0 = Date.parse(s.from), t1 = Date.parse(s.to);
  let sum = 0, n = 0;
  for (let t = t0; t < t1; t += QUARTER_MS) {
    const l = lossAt(voltage, new Date(t));
    if (l == null) return null;
    sum += l; n++;
  }
  return n ? sum / n : null;
}
