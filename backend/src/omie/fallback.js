// Parser defensivo do fallback tiagofelicia (dados.tiagofelicia.pt).
// Schema: dia(d/m/aaaa),hora(HH:MM fim do quarto),intervalo,Simples,BD,BS,
// TD,TS,preco_pt,preco_es — já em hora PT. Mantido como fonte terciária
// (CC BY 4.0, atribuição obrigatória) e para validação cruzada.

export function parseTiagoFeliciaCsv(text) {
  const rows = [];
  const quarantined = [];
  const clean = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = clean.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^dia,/i.test(line)) continue;
    const cols = line.split(',');
    if (cols.length < 9) {
      quarantined.push({ line: i + 1, reason: 'few_columns', text: line.slice(0, 140) });
      continue;
    }
    const [dia, hora, , , , , , , ptRaw, esRaw] = cols;
    const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dia.trim());
    const hm = /^(\d{2}):(\d{2})$/.exec((hora || '').trim());
    const pt = Number(String(ptRaw).trim());
    const es = esRaw !== undefined ? Number(String(esRaw).trim()) : NaN;
    if (!dm || !hm || !Number.isFinite(pt)) {
      quarantined.push({ line: i + 1, reason: 'bad_row', text: line.slice(0, 140) });
      continue;
    }
    const isoDay = `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
    rows.push({ lisbonDay: isoDay, lisbonEnd: hm[0], pricePt: pt, priceEs: Number.isFinite(es) ? es : null, srcLine: i + 1 });
  }
  return { rows, quarantined };
}

// Reconciliação por ts_lisbon: primeira fonte disponível ganha, divergência
// > 5 €/MWh entre fontes marca conflict (prefere a oficial, guarda ambas).
export const CONFLICT_EUR_MWH = 5;

export function reconcileQuarters(sourcesInPriority) {
  // sourcesInPriority: [{ name, map: Map(tsLisbon -> pricePt) }, ...]
  const keys = new Set();
  for (const s of sourcesInPriority) for (const k of s.map.keys()) keys.add(k);
  const out = [];
  for (const ts of [...keys].sort()) {
    const avail = sourcesInPriority.filter(s => s.map.has(ts));
    const chosen = avail[0];
    const others = avail.slice(1);
    const conflicts = others
      .filter(o => Math.abs(o.map.get(ts) - chosen.map.get(ts)) > CONFLICT_EUR_MWH)
      .map(o => ({ source: o.name, price: o.map.get(ts) }));
    out.push({
      ts, pricePt: chosen.map.get(ts), source: chosen.name,
      conflict: conflicts.length ? conflicts : null,
    });
  }
  return out;
}
