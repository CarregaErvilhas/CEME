// Atalho para o período horário (VAZIO / FORA_VAZIO / UNICO) de um instante.
// Por omissão usa o Continente. As regras estão todas em regions.js.

import { periodForRegion } from './regions.js';

export function periodFor({ schedule, cycle, at, region = 'CONT' }) {
  return periodForRegion({ region, schedule, cycle, at });
}
