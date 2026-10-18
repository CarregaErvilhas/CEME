// Regras de período ERSE (BT) — espelha as fórmulas CEME!X:AD mas com
// timezone real Europe/Lisbon (DST automático). Semana: domingo=vazio,
// sábado fora-vazio 09:30-13:00 e 18:30-22:00, dias úteis fora-vazio
// 07:00-24:00. Diário: fora-vazio 08:00-22:00.

// Compat: por omissão Continente. Para multi-região usar periodForRegion.
// Feriados = próprio dia (OWN_DAY): sem excepção — directiva do dono,
// o sheet nunca teve regra de feriado.

import { periodForRegion } from './regions.js';

export function periodFor({ schedule, cycle, at, region = 'CONT' }) {
  return periodForRegion({ region, schedule, cycle, at });
}
