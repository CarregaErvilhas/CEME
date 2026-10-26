// A TAR (tarifa de acesso às redes) da mobilidade eléctrica, em €/kWh sem
// IVA. Quem a fixa é a ERSE, uma vez por ano; aqui está transcrita à mão.
//
// A ERSE publica uma tabela só para Continente, Açores e Madeira; grava-se
// uma cópia por região porque a TAR procura-se sempre pela região do
// carregamento (uma região sem TAR é erro, nunca zero).
//
// Quando sair a TAR de um ano novo, acrescenta uma entrada com o
// `valid_from` desse ano (não mudes a de 2026: os carregamentos de 2026
// continuam a usá-la). Corrigir um valor de uma entrada que já existe também
// funciona: o arranque reescreve o preço na BD.
import { run } from '../db.js';
import { REGIONS } from '../engine/regions.js';

export const TAR = [
  {
    valid_from: '2026-01-01', // ERSE, Diretiva n.º 1/2026, art. 23.º
    prices: { BT: { VAZIO: 0.0266, FORA_VAZIO: 0.1192 }, MT: { VAZIO: 0.0157, FORA_VAZIO: 0.0812 } },
  },
];

// Grava a TAR na tabela `tar`: uma linha por (validade, região, tensão,
// período). É um upsert: se o preço mudou aqui, muda na BD. Não mexe em
// `valid_to`, para não reabrir uma validade fechada à mão.
export async function syncTar() {
  for (const { valid_from, prices } of TAR) {
    for (const region of Object.keys(REGIONS)) {
      for (const [voltage, byPeriod] of Object.entries(prices)) {
        for (const [period, price] of Object.entries(byPeriod)) {
          await run(`INSERT INTO tar (valid_from, valid_to, region, voltage, period, price_eur_kwh)
            VALUES ($1, NULL, $2, $3, $4, $5)
            ON CONFLICT (valid_from, region, voltage, period) DO UPDATE SET price_eur_kwh = $5`,
            [valid_from, region, voltage, period, price]);
        }
      }
    }
  }
}
