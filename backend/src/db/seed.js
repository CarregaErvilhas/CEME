// Seed completo: 24 CEME / 127 tarifários extraídos do sheet em 2026-10-15.
// (Okeana removida em 2026-10-18: última info de 2023, sem EGME discriminado.)
// Valores finais €/kWh (c/ TAR, s/ IVA). indexed: calculado em runtime.
// act = a taxa de activação PUBLICADA por cada CEME no sheet, à data da
// captura (2026-10-15) — um único significado, invariante ao longo do tempo:
// o que a folha diz, é isso. Quatro CEMEs ainda mostravam o EGME de 2025
// (0,1572: Charge2Go, Via Verde, EVPower e parte da EVIO) apesar do valor
// legal 2026 ser 0,1088 (Regul. ERSE 7/2026) — CEMEs não actualizam de
// imediato, e o simulador mostra o publicado, não o regulamentar. O legal
// (0,1088) fica como referência na API (`egme_legal`) + flag
// `activation_stale` quando o publicado está acima do legal. Já em 0,1088
// na captura: EZU, EDP, bluecharge, moeve, etc. o miio não cobra. Ver
// docs/02-motor-calculo.md.
//
// Actualizações de valores vs. sheet (2026-10-22, verificação online):
//  - galp: nova tabela publicada, em vigor desde 01/10/2026 — energia
//    (c/ TAR) vazio 0,2149 / fora 0,2895; variantes -3/-4 (18%) e -5/-6
//    (20%) recalculadas em proporção. EGME continua 0,1088 ✓.
//  - atlante: energia MyAtlante (AC) única 0,12 €/kWh (era 0,10); Business
//    mantém 0,08 (confirmado em atlante.energy/pt-pt/myatlante-business/).
//  - acp: energia sócio 0,1506 €/kWh;
//    não-sócio mantém 0,169 = EVIO ✓.
//  - bluecharge: taxa publicada na home é +0,2608 €/carregamento (não é o
//    EGME legal; é o que eles cobram).
//  - charge2go: a página publica agora "taxa EGME 0,1088 €/carregamento".
import { DatabaseSync } from 'node:sqlite';

const CEMES = [
  ['acp', "ACP", "#ac2925", "https://www.acp.pt/veiculos/eletricos/app-e-cartao-acp-electric/para-socios-e-nao-socios"],
  ['atlante', "Atlante", "#45a267", "https://atlante.energy/pt-pt/tarifas-de-energia/"],
  ['bluecharge', "Bluecharge", "#5bc0de", "https://www.bluecharge.pt/"],
  ['charge2go', "Charge2Go", "#4ca541", "https://charge2go.pt/tarifarios/"],
  ['edp', "EDP Comercial", "#212e3e", "https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/"],
  ['enable', "Enable Mobility", "#75c080", "https://www.enable-mobility.com/condutores"],
  ['evaz', "eVaz Energy", "#a3d65c", "https://www.evaz.energy/solutions/plans/mobility/"],
  ['evio', "EVIO", "#888888", "https://www.gocharge.pt/app-carregamento-eletrico/"],
  ['evpower', "EVPower", "#0073aa", "https://www.evpower.pt/particulares/"],
  ['ezu', "EZU", "#da3025", "https://ezu.pt/ceme"],
  ['factorenergia', "FactorEnergia", "#303030", "https://factorenergia.pt/servicos/cartao-mobilidade-eletrica/"],
  ['galp', "GALP Electric", "#e96224", "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ['goldenergy', "GoldEnergy", "#7edf9c", "https://goldenergy.pt/mobilidade-eletrica/"],
  ['hgp', "High Green Power", "#90b742", "https://www.highgreenpower.pt/"],
  ['iberdrola', "Iberdrola", "#00A443", "https://www.iberdrola.pt/casa/mobilidade-eletrica/carregar-fora-casa"],
  ['luzigas', "LUZiGÁS", "#87b9f9", "https://www.luzigas.pt/plano-mobilidade-eletrica/"],
  ['meo', "MEO Energia", "#00c34f", "https://www.meoenergia.pt/mobilidade-eletrica"],
  ['miio', "miio", "#318c88", "https://www.miio.com/pt/prices/charging"],
  ['mobismart', "Mobismart", "#001c5c", "https://mobismart.pt/pedir-cartao/"],
  ['moeve', "Moeve (Cepsa)", "#31404e", "https://pt.moeveglobal.com/pt/utilizacao/produtos-servicos/carregamento-eletrico"],
  ['prio', "Prio", "#0095b1", "https://www.prio.pt/downloads/file422_pt.pdf"],
  ['repsol', "Repsol", "#f19208", "https://www.repsol.pt/particulares/estrada/mobilidade-eletrica/"],
  ['viaverde', "Via Verde", "#009c3b", "https://www.viaverde.pt/particulares/via-verde/servicos/via-verde-electric"],
  ['ynerluz', "Ynerluz", "#888888", "https://www.ynerluz.com/aderir-mobilidade-eletrica/"],
];

// A decomposição do preço em energia + TAR — só para os tarifários em que a
// FOLHA tinha as duas partes separadas.
//
// Na aba "CEME" do sheet, a coluna "Valores outras fontes" é uma fórmula
// `=energia + TAR!$B$5` (ou `$C$5`, `$B$4`, `$C$4`) quando o CEME publicava
// a energia à parte; nos outros é o valor final, tal como o CEME o publica.
// O seed só transcreveu o valor final e a decomposição perdeu-se — aqui está
// recuperada da folha (30 tarifários de 11 CEMEs).
//
// A referência da célula (o `tar` de cada período) vem da folha e não da
// tabela `tar`: um tarifário pode ter sido publicado com a TAR de 2025 e o
// valor não bater certo com a TAR em vigor. Onde não há decomposição,
// `energy_only` fica NULL — não se inventa.
export const SPLITS = {
  'acp-bt-acpelectricb': { FORA_VAZIO: { energy: 0.1506, tar: 0.1192 }, VAZIO: { energy: 0.1506, tar: 0.0266 } },
  'acp-mt-acpelectricb': { FORA_VAZIO: { energy: 0.1506, tar: 0.0812 }, VAZIO: { energy: 0.1506, tar: 0.0157 } },
  'atlante-bt-myatlanteac': { FORA_VAZIO: { energy: 0.12, tar: 0.1192 }, VAZIO: { energy: 0.12, tar: 0.0266 } },
  'atlante-bt-myatlantebus': { FORA_VAZIO: { energy: 0.08, tar: 0.1192 }, VAZIO: { energy: 0.08, tar: 0.0266 } },
  'atlante-mt-myatlanteac': { FORA_VAZIO: { energy: 0.12, tar: 0.0812 }, VAZIO: { energy: 0.12, tar: 0.0157 } },
  'atlante-mt-myatlantebus': { FORA_VAZIO: { energy: 0.08, tar: 0.0812 }, VAZIO: { energy: 0.08, tar: 0.0157 } },
  'charge2go-bt-ecogreen': { FORA_VAZIO: { energy: 0.1697, tar: 0.1192 }, VAZIO: { energy: 0.1697, tar: 0.0266 } },
  'charge2go-bt-ecogreen-2': { FORA_VAZIO: { energy: 0.1697, tar: 0.1192 }, VAZIO: { energy: 0.1697, tar: 0.0266 } },
  'charge2go-mt-ecogreen': { FORA_VAZIO: { energy: 0.1697, tar: 0.0812 }, VAZIO: { energy: 0.1697, tar: 0.0157 } },
  'charge2go-mt-ecogreen-2': { FORA_VAZIO: { energy: 0.1697, tar: 0.0812 }, VAZIO: { energy: 0.1697, tar: 0.0157 } },
  'enable-bt-tarifasimple': { FORA_VAZIO: { energy: 0.12, tar: 0.0922 } },
  'enable-mt-tarifasimple': { FORA_VAZIO: { energy: 0.12, tar: 0.0922 } },
  'evio-bt-evio': { FORA_VAZIO: { energy: 0.169, tar: 0.1192 }, VAZIO: { energy: 0.169, tar: 0.0266 } },
  'evio-bt-gochargeby': { FORA_VAZIO: { energy: 0.169, tar: 0.1192 }, VAZIO: { energy: 0.169, tar: 0.0266 } },
  'evio-mt-evio': { FORA_VAZIO: { energy: 0.169, tar: 0.0812 }, VAZIO: { energy: 0.169, tar: 0.0157 } },
  'evio-mt-gochargeby': { FORA_VAZIO: { energy: 0.169, tar: 0.0812 }, VAZIO: { energy: 0.169, tar: 0.0157 } },
  'evpower-bt-cartoevpower': { FORA_VAZIO: { energy: 0.1952, tar: 0.1192 }, VAZIO: { energy: 0.1729, tar: 0.0266 } },
  'evpower-mt-cartoevpower': { FORA_VAZIO: { energy: 0.1884, tar: 0.0812 }, VAZIO: { energy: 0.1691, tar: 0.0157 } },
  'ezu-bt-abenergia': { FORA_VAZIO: { energy: 0.099, tar: 0.1192 }, VAZIO: { energy: 0.099, tar: 0.0266 } },
  'ezu-bt-tarifrioceme': { FORA_VAZIO: { energy: 0.15, tar: 0.1192 }, VAZIO: { energy: 0.15, tar: 0.0266 } },
  'ezu-mt-abenergia': { FORA_VAZIO: { energy: 0.099, tar: 0.0812 }, VAZIO: { energy: 0.099, tar: 0.0157 } },
  'ezu-mt-tarifrioceme': { FORA_VAZIO: { energy: 0.15, tar: 0.0812 }, VAZIO: { energy: 0.15, tar: 0.0157 } },
  'hgp-bt-cartoceme': { FORA_VAZIO: { energy: 0.27, tar: 0.1192 }, VAZIO: { energy: 0.27, tar: 0.0266 } },
  'hgp-mt-cartoceme': { FORA_VAZIO: { energy: 0.27, tar: 0.0812 }, VAZIO: { energy: 0.27, tar: 0.0157 } },
  'mobismart-bt-cartode': { FORA_VAZIO: { energy: 0.25, tar: 0.1192 }, VAZIO: { energy: 0.2, tar: 0.0266 } },
  'mobismart-bt-cartode-2': { FORA_VAZIO: { energy: 0.3, tar: 0.1192 }, VAZIO: { energy: 0.25, tar: 0.0266 } },
  'mobismart-mt-cartode': { FORA_VAZIO: { energy: 0.25, tar: 0.0812 }, VAZIO: { energy: 0.2, tar: 0.0157 } },
  'mobismart-mt-cartode-2': { FORA_VAZIO: { energy: 0.3, tar: 0.0812 }, VAZIO: { energy: 0.25, tar: 0.0157 } },
  'prio-bt-prioelectric': { FORA_VAZIO: { energy: 0.1399, tar: 0.1192 }, VAZIO: { energy: 0.1499, tar: 0.0266 } },
  'prio-mt-prioelectric': { FORA_VAZIO: { energy: 0.1399, tar: 0.0812 }, VAZIO: { energy: 0.1499, tar: 0.0157 } },
  'viaverde-bt-viaverdeelec': { FORA_VAZIO: { energy: 0.148, tar: 0.1192 }, VAZIO: { energy: 0.148, tar: 0.0266 } },
  'viaverde-bt-viaverdeelec-2': { FORA_VAZIO: { energy: 0.148, tar: 0.1192 }, VAZIO: { energy: 0.148, tar: 0.0266 } },
  'viaverde-mt-viaverdeelec': { FORA_VAZIO: { energy: 0.148, tar: 0.0812 }, VAZIO: { energy: 0.148, tar: 0.0157 } },
  'viaverde-mt-viaverdeelec-2': { FORA_VAZIO: { energy: 0.148, tar: 0.0812 }, VAZIO: { energy: 0.148, tar: 0.0157 } },
};

const TARIFFS = [
  // (AC) = carregamento em corrente alternada. A Atlante tem um preço
  // promocional flat nos postos DC, com CEME + OPC included — por isso o
  // nome leva (AC). As duas tensões existem; faltava a BT.
  ["atlante-bt-myatlanteac", "atlante", "myAtlante (AC)", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 1, 0, "CONT", { "VAZIO": 0.1466, "FORA_VAZIO": 0.2392 }, 0.11, 0.0, 0.001, 0, "https://atlante.energy/pt-pt/tarifas-de-energia/"],
  ["atlante-mt-myatlanteac", "atlante", "myAtlante (AC)", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 1, 0, "CONT", { "VAZIO": 0.1357, "FORA_VAZIO": 0.2012 }, 0.11, 0.0, 0.001, 0, "https://atlante.energy/pt-pt/tarifas-de-energia/"],
  ["atlante-bt-myatlantebus", "atlante", "myAtlante Business (AC)", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.1066, "FORA_VAZIO": 0.1992 }, 0.11, 0.0, 0.001, 0, "https://atlante.energy/pt-pt/tarifas-de-energia/"],
  ["atlante-mt-myatlantebus", "atlante", "myAtlante Business (AC)", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.0957, "FORA_VAZIO": 0.1612 }, 0.11, 0.0, 0.001, 0, "https://atlante.energy/pt-pt/tarifas-de-energia/"],
  ["bluecharge-bt-cartobluecha", "bluecharge", "Cartão Bluecharge", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", { "VAZIO": 0.249, "FORA_VAZIO": 0.269 }, 0.2608, 0.0, 0.001, 0, "https://www.bluecharge.pt/"],
  ["bluecharge-mt-cartobluecha", "bluecharge", "Cartão Bluecharge", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", { "VAZIO": 0.249, "FORA_VAZIO": 0.269 }, 0.2608, 0.0, 0.001, 0, "https://www.bluecharge.pt/"],
  ["bluecharge-bt-cartobluecha-2", "bluecharge", "Cartão Bluecharge", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 0, 0, "CONT", { "VAZIO": 0.249, "FORA_VAZIO": 0.269 }, 0.2608, 0.0, 0.001, 0, "https://www.bluecharge.pt/"],
  ["bluecharge-mt-cartobluecha-2", "bluecharge", "Cartão Bluecharge", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 0, 0, "CONT", { "VAZIO": 0.249, "FORA_VAZIO": 0.269 }, 0.2608, 0.0, 0.001, 0, "https://www.bluecharge.pt/"],
  ["moeve-bt-gow", "moeve", "GOW", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", { "VAZIO": 0.24, "FORA_VAZIO": 0.32 }, 0.1088, 0.0, 0.001, 0, "https://pt.moeveglobal.com/pt/utilizacao/produtos-servicos/carregamento-eletrico"],
  ["moeve-mt-gow", "moeve", "GOW", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", { "VAZIO": 0.22, "FORA_VAZIO": 0.27 }, 0.1088, 0.0, 0.001, 0, "https://pt.moeveglobal.com/pt/utilizacao/produtos-servicos/carregamento-eletrico"],
  ["charge2go-bt-ecogreen", "charge2go", "Eco Green", "FIXED", "BT", "BI_HORARIA", "DIARIO", 0, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.1963, "FORA_VAZIO": 0.2889 }, 0.1088, 0.0, 0.001, 0, "https://charge2go.pt/tarifarios/"],
  ["charge2go-bt-ecogreen-2", "charge2go", "Eco Green", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 0, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.1963, "FORA_VAZIO": 0.2889 }, 0.1088, 0.0, 0.001, 0, "https://charge2go.pt/tarifarios/"],
  ["charge2go-mt-ecogreen", "charge2go", "Eco Green", "FIXED", "MT", "BI_HORARIA", "DIARIO", 0, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.1854, "FORA_VAZIO": 0.2509 }, 0.1088, 0.0, 0.001, 0, "https://charge2go.pt/tarifarios/"],
  ["charge2go-mt-ecogreen-2", "charge2go", "Eco Green", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 0, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.1854, "FORA_VAZIO": 0.2509 }, 0.1088, 0.0, 0.001, 0, "https://charge2go.pt/tarifarios/"],
  ["viaverde-bt-viaverdeelec", "viaverde", "Via Verde Electric by ECOCHOICE", "FIXED", "BT", "BI_HORARIA", "DIARIO", 0, "AMBOS", 1, 0, "CONT", { "VAZIO": 0.1746, "FORA_VAZIO": 0.2672 }, 0.1572, 0.0, 0.001, 0, "https://www.viaverde.pt/particulares/via-verde/servicos/via-verde-electric"],
  ["viaverde-bt-viaverdeelec-2", "viaverde", "Via Verde Electric by ECOCHOICE", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 0, "AMBOS", 1, 0, "CONT", { "VAZIO": 0.1746, "FORA_VAZIO": 0.2672 }, 0.1572, 0.0, 0.001, 0, "https://www.viaverde.pt/particulares/via-verde/servicos/via-verde-electric"],
  ["viaverde-mt-viaverdeelec", "viaverde", "Via Verde Electric by ECOCHOICE", "FIXED", "MT", "BI_HORARIA", "DIARIO", 0, "AMBOS", 1, 0, "CONT", { "VAZIO": 0.1637, "FORA_VAZIO": 0.2292 }, 0.1572, 0.0, 0.001, 0, "https://www.viaverde.pt/particulares/via-verde/servicos/via-verde-electric"],
  ["viaverde-mt-viaverdeelec-2", "viaverde", "Via Verde Electric by ECOCHOICE", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 0, "AMBOS", 1, 0, "CONT", { "VAZIO": 0.1637, "FORA_VAZIO": 0.2292 }, 0.1572, 0.0, 0.001, 0, "https://www.viaverde.pt/particulares/via-verde/servicos/via-verde-electric"],
  ["edp-bt-cartoedp", "edp", "Cartão EDP Charge (Simples)", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 1, 0, "CONT", { "UNICO": 0.2678 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-mt-cartoedp", "edp", "Cartão EDP Charge (Simples)", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 1, 0, "CONT", { "UNICO": 0.2678 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-bt-cartoedp-2", "edp", "Cartão EDP Charge (Simples) Associados UVE (10%)", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 1, 1, "CONT", { "UNICO": 0.24102 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-mt-cartoedp-2", "edp", "Cartão EDP Charge (Simples) Associados UVE (10%)", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 1, 1, "CONT", { "UNICO": 0.24102 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-bt-cartoedp-3", "edp", "Cartão EDP Charge (Simples) Clientes energia (20%)", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 1, 1, "CONT", { "UNICO": 0.21424 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-mt-cartoedp-3", "edp", "Cartão EDP Charge (Simples) Clientes energia (20%)", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 1, 1, "CONT", { "UNICO": 0.21424 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-bt-cartoedp-4", "edp", "Cartão EDP Charge (Simples) Clientes energia / UVE (30%)", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", { "UNICO": 0.18746 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-mt-cartoedp-4", "edp", "Cartão EDP Charge (Simples) Clientes energia / UVE (30%)", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", { "UNICO": 0.18746 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-bt-cartoedp-5", "edp", "Cartão EDP Charge (Simples) Colaboradores (25%)", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", { "UNICO": 0.20085 }, 0.1088, 0.0, 0.001, 0, ""],
  ["edp-mt-cartoedp-5", "edp", "Cartão EDP Charge (Simples) Colaboradores (25%)", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", { "UNICO": 0.20085 }, 0.1088, 0.0, 0.001, 0, ""],
  ["edp-bt-cartoedp-6", "edp", "Cartão EDP Charge Frota (Simples)", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", { "UNICO": 0.2591 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/"],
  ["edp-mt-cartoedp-6", "edp", "Cartão EDP Charge Frota (Simples)", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", { "UNICO": 0.2591 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/"],
  ["edp-bt-cartoedp-7", "edp", "Cartão EDP Charge Frota (Simples) Clientes Energia", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", { "UNICO": 0.20728 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/"],
  ["edp-mt-cartoedp-7", "edp", "Cartão EDP Charge Frota (Simples) Clientes Energia", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", { "UNICO": 0.20728 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/"],
  ["edp-bt-cartoedp-8", "edp", "Cartão EDP Charge (Bi-Horário)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 0, "CONT", { "VAZIO": 0.1927, "FORA_VAZIO": 0.2826 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-mt-cartoedp-8", "edp", "Cartão EDP Charge (Bi-Horário)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 0, "CONT", { "VAZIO": 0.1927, "FORA_VAZIO": 0.2826 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-bt-cartoedp-9", "edp", "Cartão EDP Charge (Bi-Horário) Associados UVE (10%)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.17343, "FORA_VAZIO": 0.25434 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-mt-cartoedp-9", "edp", "Cartão EDP Charge (Bi-Horário) Associados UVE (10%)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.17343, "FORA_VAZIO": 0.25434 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-bt-cartoedp-10", "edp", "Cartão EDP Charge (Bi-Horário) Clientes energia (20%)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.15416, "FORA_VAZIO": 0.22608 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-mt-cartoedp-10", "edp", "Cartão EDP Charge (Bi-Horário) Clientes energia (20%)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.15416, "FORA_VAZIO": 0.22608 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-bt-cartoedp-11", "edp", "Cartão EDP Charge (Bi-Horário) Clientes energia / UVE (30%)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.13489, "FORA_VAZIO": 0.19782 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-mt-cartoedp-11", "edp", "Cartão EDP Charge (Bi-Horário) Clientes energia / UVE (30%)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.13489, "FORA_VAZIO": 0.19782 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-bt-cartoedp-12", "edp", "Cartão EDP Charge (Bi-Horário) Colaboradores (25%)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.144525, "FORA_VAZIO": 0.21195 }, 0.1088, 0.0, 0.001, 0, ""],
  ["edp-mt-cartoedp-12", "edp", "Cartão EDP Charge (Bi-Horário) Colaboradores (25%)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.144525, "FORA_VAZIO": 0.21195 }, 0.1088, 0.0, 0.001, 0, ""],
  ["edp-bt-cartoedp-13", "edp", "Cartão EDP Charge (Bi-Horário) Frota", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.2121, "FORA_VAZIO": 0.2681 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/"],
  ["edp-mt-cartoedp-13", "edp", "Cartão EDP Charge (Bi-Horário) Frota", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.2121, "FORA_VAZIO": 0.2681 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/"],
  ["edp-bt-cartoedp-14", "edp", "Cartão EDP Charge (Bi-Horário) Frota Clientes Energia", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.16968, "FORA_VAZIO": 0.21448 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/"],
  ["edp-mt-cartoedp-14", "edp", "Cartão EDP Charge (Bi-Horário) Frota Clientes Energia", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.16968, "FORA_VAZIO": 0.21448 }, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/"],
  ["evpower-bt-cartoevpower", "evpower", "Cartão EVpower", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.1995, "FORA_VAZIO": 0.3144 }, 0.1572, 0.0, 0.001, 0, "https://www.evpower.pt/particulares/"],
  ["evpower-mt-cartoevpower", "evpower", "Cartão EVpower", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.1848, "FORA_VAZIO": 0.2696 }, 0.1572, 0.0, 0.001, 0, "https://www.evpower.pt/particulares/"],
  ["evaz-bt-planomovebas", "evaz", "Plano Move Base", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.169, "FORA_VAZIO": 0.2635 }, 0.1088, 0.0, 0.001, 0, "https://www.evaz.energy/solutions/plans/mobility/"],
  ["evaz-mt-planomovebas", "evaz", "Plano Move Base", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.169, "FORA_VAZIO": 0.2635 }, 0.1088, 0.0, 0.001, 0, "https://www.evaz.energy/solutions/plans/mobility/"],
  ["evaz-bt-planomovebas-2", "evaz", "Plano Move Base", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.169, "FORA_VAZIO": 0.2635 }, 0.1088, 0.0, 0.001, 0, "https://www.evaz.energy/solutions/plans/mobility/"],
  ["evaz-mt-planomovebas-2", "evaz", "Plano Move Base", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.169, "FORA_VAZIO": 0.2635 }, 0.1088, 0.0, 0.001, 0, "https://www.evaz.energy/solutions/plans/mobility/"],
  ["evaz-bt-planomovehom", "evaz", "Plano Move HOME", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 1, "CONT", { "VAZIO": 0.16055, "FORA_VAZIO": 0.250325 }, 0.1088, 0.0, 0.001, 0, "https://www.evaz.energy/solutions/plans/mobility/"],
  ["evaz-mt-planomovehom", "evaz", "Plano Move HOME", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 1, "CONT", { "VAZIO": 0.16055, "FORA_VAZIO": 0.250325 }, 0.1088, 0.0, 0.001, 0, "https://www.evaz.energy/solutions/plans/mobility/"],
  ["evaz-bt-planomovehom-2", "evaz", "Plano Move HOME", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "CARTAO", 0, 1, "CONT", { "VAZIO": 0.16055, "FORA_VAZIO": 0.250325 }, 0.1088, 0.0, 0.001, 0, "https://www.evaz.energy/solutions/plans/mobility/"],
  ["evaz-mt-planomovehom-2", "evaz", "Plano Move HOME", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "CARTAO", 0, 1, "CONT", { "VAZIO": 0.16055, "FORA_VAZIO": 0.250325 }, 0.1088, 0.0, 0.001, 0, "https://www.evaz.energy/solutions/plans/mobility/"],
  ["acp-bt-acpelectricb", "acp", "ACP Electric by EVIO - sócio ACP", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 1, "CONT", { "VAZIO": 0.1772, "FORA_VAZIO": 0.2698 }, 0.15, 0.0, 0.001, 0, "https://www.acp.pt/veiculos/eletricos/app-e-cartao-acp-electric/para-socios-e-nao-socios"],
  ["acp-mt-acpelectricb", "acp", "ACP Electric by EVIO - sócio ACP", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 1, "CONT", { "VAZIO": 0.1663, "FORA_VAZIO": 0.2318 }, 0.15, 0.0, 0.001, 0, "https://www.acp.pt/veiculos/eletricos/app-e-cartao-acp-electric/para-socios-e-nao-socios"],
  ["acp-bt-acpelectricb-2", "acp", "ACP Electric by EVIO - não sócio ACP", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", { "VAZIO": 0.1956, "FORA_VAZIO": 0.2882 }, 0.15, 0.0, 0.001, 0, "https://www.acp.pt/veiculos/eletricos/app-e-cartao-acp-electric/para-socios-e-nao-socios"],
  ["acp-mt-acpelectricb-2", "acp", "ACP Electric by EVIO - não sócio ACP", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", { "VAZIO": 0.1847, "FORA_VAZIO": 0.2502 }, 0.15, 0.0, 0.001, 0, "https://www.acp.pt/veiculos/eletricos/app-e-cartao-acp-electric/para-socios-e-nao-socios"],
  ["enable-bt-tarifasimple", "enable", "Tarifa Simples", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 1, 0, "CONT", { "UNICO": 0.21215 }, 0.1088, 0.0, 0.001, 0, "https://www.enable-mobility.com/condutores"],
  ["enable-mt-tarifasimple", "enable", "Tarifa Simples", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 1, 0, "CONT", { "UNICO": 0.21215 }, 0.1088, 0.0, 0.001, 0, "https://www.enable-mobility.com/condutores"],
  ["evio-bt-hyundaiblue", "evio", "Hyundai Blue", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.1956, "FORA_VAZIO": 0.2882 }, 0.1572, 0.0, 0.001, 0, "https://ceme.go-evio.com/pt/site-ceme"],
  ["evio-mt-hyundaiblue", "evio", "Hyundai Blue", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.1847, "FORA_VAZIO": 0.2502 }, 0.1572, 0.0, 0.001, 0, "https://ceme.go-evio.com/pt/site-ceme"],
  ["evio-bt-evio", "evio", "EVIO", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 0, "CONT", { "VAZIO": 0.1956, "FORA_VAZIO": 0.2882 }, 0.15, 0.0, 0.001, 0, "https://ceme.go-evio.com/pt/site-ceme"],
  ["evio-mt-evio", "evio", "EVIO", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 0, "CONT", { "VAZIO": 0.1847, "FORA_VAZIO": 0.2502 }, 0.15, 0.0, 0.001, 0, "https://ceme.go-evio.com/pt/site-ceme"],
  ["evio-bt-gochargeby", "evio", "Go.Charge by EVIO", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.1956, "FORA_VAZIO": 0.2882 }, 0.1572, 0.0, 0.001, 0, "https://www.gocharge.pt/app-carregamento-eletrico/"],
  ["evio-mt-gochargeby", "evio", "Go.Charge by EVIO", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.1847, "FORA_VAZIO": 0.2502 }, 0.1572, 0.0, 0.001, 0, "https://www.gocharge.pt/app-carregamento-eletrico/"],
  ["ezu-bt-tarifrioceme", "ezu", "Tarifário CEME", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.1766, "FORA_VAZIO": 0.2692 }, 0.1088, 0.0, 0.001, 0, "https://ezu.pt/ceme"],
  ["ezu-mt-tarifrioceme", "ezu", "Tarifário CEME", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.1657, "FORA_VAZIO": 0.2312 }, 0.1088, 0.0, 0.001, 0, "https://ezu.pt/ceme"],
  ["ezu-bt-abenergia", "ezu", "AB Energia", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 1, "CONT", { "VAZIO": 0.1256, "FORA_VAZIO": 0.2182 }, 0.1088, 0.0, 0.001, 0, "https://ezu.pt/ceme"],
  ["ezu-mt-abenergia", "ezu", "AB Energia", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 1, "CONT", { "VAZIO": 0.1147, "FORA_VAZIO": 0.1802 }, 0.1088, 0.0, 0.001, 0, "https://ezu.pt/ceme"],
  ["factorenergia-bt-vecard", "factorenergia", "VECARD", "FIXED", "BT", "BI_HORARIA", "DIARIO", 0, "CARTAO", 0, 1, "CONT", { "VAZIO": 0.19, "FORA_VAZIO": 0.295 }, 0.1088, 0.0, 0.001, 0, "https://factorenergia.pt/servicos/cartao-mobilidade-eletrica/"],
  ["factorenergia-mt-vecard", "factorenergia", "VECARD", "FIXED", "MT", "BI_HORARIA", "DIARIO", 0, "CARTAO", 0, 1, "CONT", { "VAZIO": 0.19, "FORA_VAZIO": 0.295 }, 0.1088, 0.0, 0.001, 0, "https://factorenergia.pt/servicos/cartao-mobilidade-eletrica/"],
  ["factorenergia-bt-vecard-2", "factorenergia", "VECARD", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 0, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.19, "FORA_VAZIO": 0.295 }, 0.1088, 0.0, 0.001, 0, "https://factorenergia.pt/servicos/cartao-mobilidade-eletrica/"],
  ["factorenergia-mt-vecard-2", "factorenergia", "VECARD", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 0, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.19, "FORA_VAZIO": 0.295 }, 0.1088, 0.0, 0.001, 0, "https://factorenergia.pt/servicos/cartao-mobilidade-eletrica/"],
  ["galp-bt-galpelectric", "galp", "Galp Electric Energia Verde", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 0, "CONT", { "VAZIO": 0.2149, "FORA_VAZIO": 0.2895 }, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-mt-galpelectric", "galp", "Galp Electric Energia Verde", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 0, "CONT", { "VAZIO": 0.2149, "FORA_VAZIO": 0.2895 }, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-bt-galpelectric-2", "galp", "Galp Electric Energia Verde", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 1, 0, "CONT", { "VAZIO": 0.2149, "FORA_VAZIO": 0.2895 }, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-mt-galpelectric-2", "galp", "Galp Electric Energia Verde", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 1, 0, "CONT", { "VAZIO": 0.2149, "FORA_VAZIO": 0.2895 }, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-bt-galpelectric-3", "galp", "Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar sem Wallbox (18% desconto)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 1, "CONT", { "VAZIO": 0.176218, "FORA_VAZIO": 0.23739 }, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-mt-galpelectric-3", "galp", "Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar sem Wallbox (18% desconto)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 1, "CONT", { "VAZIO": 0.176218, "FORA_VAZIO": 0.23739 }, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-bt-galpelectric-4", "galp", "Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar sem Wallbox (18% desconto)", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 1, 1, "CONT", { "VAZIO": 0.176218, "FORA_VAZIO": 0.23739 }, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-mt-galpelectric-4", "galp", "Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar sem Wallbox (18% desconto)", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 1, 1, "CONT", { "VAZIO": 0.176218, "FORA_VAZIO": 0.23739 }, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-bt-galpelectric-5", "galp", "Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar com Wallbox (20% desconto)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.17192, "FORA_VAZIO": 0.2316 }, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-mt-galpelectric-5", "galp", "Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar com Wallbox (20% desconto)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.17192, "FORA_VAZIO": 0.2316 }, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-bt-galpelectric-6", "galp", "Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar com Wallbox (20% desconto)", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.17192, "FORA_VAZIO": 0.2316 }, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-mt-galpelectric-6", "galp", "Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar com Wallbox (20% desconto)", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.17192, "FORA_VAZIO": 0.2316 }, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["goldenergy-bt-clientesgold", "goldenergy", "Clientes Goldenergy Comercialização", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", { "UNICO": 0.2222 }, 0.1088, 0.0, 0.001, 0, "https://goldenergy.pt/blog/mobilidade-eletrica/"],
  ["goldenergy-mt-clientesgold", "goldenergy", "Clientes Goldenergy Comercialização", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", { "UNICO": 0.2222 }, 0.1088, 0.0, 0.001, 0, "https://goldenergy.pt/blog/mobilidade-eletrica/"],
  ["goldenergy-bt-noclientes", "goldenergy", "Não Clientes Goldenergy Comercialização", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 0, "CONT", { "UNICO": 0.2778 }, 0.1088, 0.0, 0.001, 0, "https://goldenergy.pt/blog/mobilidade-eletrica/"],
  ["goldenergy-mt-noclientes", "goldenergy", "Não Clientes Goldenergy Comercialização", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 0, "CONT", { "UNICO": 0.2778 }, 0.1088, 0.0, 0.001, 0, "https://goldenergy.pt/blog/mobilidade-eletrica/"],
  ["hgp-bt-cartoceme", "hgp", "Cartão CEME", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.2966, "FORA_VAZIO": 0.3892 }, 0.1088, 0.0, 0.001, 0, "https://www.highgreenpower.pt/mobilidade-eletrica-setor-publico-mobi-e/"],
  ["hgp-mt-cartoceme", "hgp", "Cartão CEME", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.2857, "FORA_VAZIO": 0.3512 }, 0.1088, 0.0, 0.001, 0, "https://www.highgreenpower.pt/mobilidade-eletrica-setor-publico-mobi-e/"],
  ["iberdrola-bt-cartomobilid", "iberdrola", "Cartão Mobilidade Elétrica", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "CARTAO", 1, 0, "CONT", { "UNICO": 0.2486 }, 0.1088, 0.0, 0.001, 0, "https://www.iberdrola.pt/casa/mobilidade-eletrica/carregar-fora-casa"],
  ["iberdrola-mt-cartomobilid", "iberdrola", "Cartão Mobilidade Elétrica", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "CARTAO", 1, 0, "CONT", { "UNICO": 0.2486 }, 0.1088, 0.0, 0.001, 0, "https://www.iberdrola.pt/casa/mobilidade-eletrica/carregar-fora-casa"],
  ["iberdrola-bt-clienteeletr", "iberdrola", "Cliente Eletricidade Iberdrola", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "CARTAO", 0, 1, "CONT", { "UNICO": 0.1989 }, 0.1088, 0.0, 0.001, 0, "https://www.iberdrola.pt/casa/mobilidade-eletrica/carregar-fora-casa"],
  ["iberdrola-mt-clienteeletr", "iberdrola", "Cliente Eletricidade Iberdrola", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "CARTAO", 0, 1, "CONT", { "UNICO": 0.1989 }, 0.1088, 0.0, 0.001, 0, "https://www.iberdrola.pt/casa/mobilidade-eletrica/carregar-fora-casa"],
  ["meo-bt-mobilidadeel", "meo", "Mobilidade Elétrica com Tarifa Fixa Colaboradores MEO only", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "CARTAO", 0, 1, "CONT", { "UNICO": 0.195 }, 0.1088, 0.0, 0.001, 0, "https://www.meoenergia.pt/mobilidade-eletrica"],
  ["meo-mt-mobilidadeel", "meo", "Mobilidade Elétrica com Tarifa Fixa Colaboradores MEO only", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "CARTAO", 0, 1, "CONT", { "UNICO": 0.195 }, 0.1088, 0.0, 0.001, 0, "https://www.meoenergia.pt/mobilidade-eletrica"],
  ["meo-bt-mobilidadeel-2", "meo", "Mobilidade Elétrica com Tarifa Fixa Cliente MEO Energia e tem MEO M5e/M4e", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "CARTAO", 0, 1, "CONT", { "UNICO": 0.225 }, 0.1088, 0.0, 0.001, 0, "https://www.meoenergia.pt/mobilidade-eletrica"],
  ["meo-mt-mobilidadeel-2", "meo", "Mobilidade Elétrica com Tarifa Fixa Cliente MEO Energia e tem MEO M5e/M4e", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "CARTAO", 0, 1, "CONT", { "UNICO": 0.225 }, 0.1088, 0.0, 0.001, 0, "https://www.meoenergia.pt/mobilidade-eletrica"],
  ["miio-bt-miiobihor", "miio", "miio (Bi-Horário Semanal) sem subscrição", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 1, 0, "CONT", { "VAZIO": 0.2666, "FORA_VAZIO": 0.3592 }, 0.0, 0.0, 0.001, 0, "https://www.miio.com/pt/miio-one"],
  ["miio-mt-miiobihor", "miio", "miio (Bi-Horário Semanal) sem subscrição", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 1, 0, "CONT", { "VAZIO": 0.2557, "FORA_VAZIO": 0.3212 }, 0.0, 0.0, 0.001, 0, "https://www.miio.com/pt/miio-one"],
  ["miio-bt-miioonebi", "miio", "miio one (Bi-Horário Semanal) subscrição", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.1966, "FORA_VAZIO": 0.2892 }, 0.0, 0.0, 0.001, 0, "https://www.miio.com/pt/miio-one"],
  ["miio-mt-miioonebi", "miio", "miio one (Bi-Horário Semanal) subscrição", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.1857, "FORA_VAZIO": 0.2512 }, 0.0, 0.0, 0.001, 0, "https://www.miio.com/pt/miio-one"],
  ["miio-bt-miiobihor-2", "miio", "miio (Bi-Horário Diário) sem subscrição", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", { "VAZIO": 0.2666, "FORA_VAZIO": 0.3592 }, 0.0, 0.0, 0.001, 0, "https://www.miio.com/pt/miio-one"],
  ["miio-mt-miiobihor-2", "miio", "miio (Bi-Horário Diário) sem subscrição", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", { "VAZIO": 0.2557, "FORA_VAZIO": 0.3212 }, 0.0, 0.0, 0.001, 0, "https://www.miio.com/pt/miio-one"],
  ["miio-bt-miioonebi-2", "miio", "miio one (Bi-Horário Diário) subscrição", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.1966, "FORA_VAZIO": 0.2892 }, 0.0, 0.0, 0.001, 0, "https://www.miio.com/pt/miio-one"],
  ["miio-mt-miioonebi-2", "miio", "miio one (Bi-Horário Diário) subscrição", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", { "VAZIO": 0.1857, "FORA_VAZIO": 0.2512 }, 0.0, 0.0, 0.001, 0, "https://www.miio.com/pt/miio-one"],
  ["mobismart-bt-cartode", "mobismart", "Cartão de carregamento público e privado MOBISMART (pós-pago)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 0, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.2266, "FORA_VAZIO": 0.3692 }, 0.1088, 0.0, 0.001, 0, "https://mobismart.pt/pedir-cartao/"],
  ["mobismart-mt-cartode", "mobismart", "Cartão de carregamento público e privado MOBISMART (pós-pago)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 0, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.2157, "FORA_VAZIO": 0.3312 }, 0.1088, 0.0, 0.001, 0, "https://mobismart.pt/pedir-cartao/"],
  ["mobismart-bt-cartode-2", "mobismart", "Cartão de carregamento público e privado MOBISMART (pré-pago)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 0, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.2766, "FORA_VAZIO": 0.4192 }, 0.1088, 0.0, 0.001, 0, "https://mobismart.pt/pedir-cartao/"],
  ["mobismart-mt-cartode-2", "mobismart", "Cartão de carregamento público e privado MOBISMART (pré-pago)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 0, "CARTAO", 0, 0, "CONT", { "VAZIO": 0.2657, "FORA_VAZIO": 0.3812 }, 0.1088, 0.0, 0.001, 0, "https://mobismart.pt/pedir-cartao/"],
  ["prio-bt-prioelectric", "prio", "Prio Electric (EUR/kWh)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 0, "CONT", { "VAZIO": 0.1765, "FORA_VAZIO": 0.2591 }, 0.1088, 0.0, 0.001, 0, "https://www.prio.pt/downloads/file422_pt.pdf"],
  ["prio-mt-prioelectric", "prio", "Prio Electric (EUR/kWh)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 0, "CONT", { "VAZIO": 0.1656, "FORA_VAZIO": 0.2211 }, 0.1088, 0.0, 0.001, 0, "https://www.prio.pt/downloads/file422_pt.pdf"],
  ["repsol-bt-pessoassingu", "repsol", "Pessoas Singulares", "FIXED", "BT", "SIMPLES", "SIMPLES", 0, "CARTAO", 0, 0, "CONT", { "UNICO": 0.2868 }, 0.1088, 0.0, 0.001, 0, "https://www.repsol.pt/particulares/estrada/mobilidade-eletrica/"],
  ["repsol-mt-pessoassingu", "repsol", "Pessoas Singulares", "FIXED", "MT", "SIMPLES", "SIMPLES", 0, "CARTAO", 0, 0, "CONT", { "UNICO": 0.2868 }, 0.1088, 0.0, 0.001, 0, "https://www.repsol.pt/particulares/estrada/mobilidade-eletrica/"],
  ["ynerluz-bt", "ynerluz", "Mobilidade Elétrica", "INDEXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", null, 0.1572, 0.0, 0.001, 0, "https://www.ynerluz.com/aderir-mobilidade-eletrica/"],
  ["ynerluz-mt", "ynerluz", "Mobilidade Elétrica", "INDEXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", null, 0.1572, 0.0, 0.001, 0, "https://www.ynerluz.com/aderir-mobilidade-eletrica/"],
  ["luzigas-ceme-bt", "luzigas", "Tarifário Indexado Cliente CEME", "INDEXED", "BT", "BI_HORARIA", "SEMANAL", 0, "CARTAO", 1, 0, "CONT", null, 0.1088, 0.0, 0.001, 0, "https://www.luzigas.pt/plano-mobilidade-eletrica/"],
  ["luzigas-ceme-mt", "luzigas", "Tarifário Indexado Cliente CEME", "INDEXED", "MT", "BI_HORARIA", "SEMANAL", 0, "CARTAO", 1, 0, "CONT", null, 0.1088, 0.0, 0.001, 0, "https://www.luzigas.pt/plano-mobilidade-eletrica/"],
  ["luzigas-casa-bt", "luzigas", "Tarifário Indexado Cliente Casa e CEME", "INDEXED", "BT", "BI_HORARIA", "SEMANAL", 0, "CARTAO", 1, 1, "CONT", null, 0.1088, 0.0, 0.001, 0, "https://www.luzigas.pt/plano-mobilidade-eletrica/"],
  ["luzigas-casa-mt", "luzigas", "Tarifário Indexado Cliente Casa e CEME", "INDEXED", "MT", "BI_HORARIA", "SEMANAL", 0, "CARTAO", 1, 1, "CONT", null, 0.1088, 0.0, 0.001, 0, "https://www.luzigas.pt/plano-mobilidade-eletrica/"],
  ["luzigas-k0010-bt", "luzigas", "Tarifário Indexado Cliente CEME (K=0,010)", "INDEXED", "BT", "BI_HORARIA", "SEMANAL", 0, "AMBOS", 0, 1, "CONT", null, 0.1088, 0.0, 0.001, 0, "https://www.luzigas.pt/plano-mobilidade-eletrica/"],
  ["luzigas-k0010-mt", "luzigas", "Tarifário Indexado Cliente CEME (K=0,010)", "INDEXED", "MT", "BI_HORARIA", "SEMANAL", 0, "AMBOS", 0, 1, "CONT", null, 0.1088, 0.0, 0.001, 0, "https://www.luzigas.pt/plano-mobilidade-eletrica/"],
  ["meo-dinamica-bt", "meo", "Mobilidade Elétrica com Tarifa Dinâmica Exclusivo Clientes MEO *e* MEO Energia", "INDEXED", "BT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 1, "CONT", null, 0.1088, 0.0, 0.001, 0, "https://www.meoenergia.pt/mobilidade-eletrica"],
  ["meo-dinamica-mt", "meo", "Mobilidade Elétrica com Tarifa Dinâmica Exclusivo Clientes MEO *e* MEO Energia", "INDEXED", "MT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 1, "CONT", null, 0.1088, 0.0, 0.001, 0, "https://www.meoenergia.pt/mobilidade-eletrica"],
];

// Notas que a folha CEME nao traz, porem o nome do tarifario sugere. Sao
// CODIGOS, nao texto: o cliente traduz (mesmo padrao de OMIE_CONT_REF), para
// nao meter portugues na interface english.
const NOTES = {
  'atlante-bt-myatlanteac': 'AC_DC_FLAT',
  'atlante-mt-myatlanteac': 'AC_DC_FLAT',
  'atlante-bt-myatlantebus': 'AC_DC_FLAT',
  'atlante-mt-myatlantebus': 'AC_DC_FLAT',
};

// Data em que a folha CEME (e portanto o simulador original) reflecte a ERSE.
// E o que sabemos com certeza. O que NAO sabemos, e nunca vamos saber sem ir a
// cada comercializador, e a data em que cada tarifario comecou a vigorar — a
// folha nao tem coluna de datas. Por isso `valid_from` = data de captura, e a
// UI diz "precos verificados em" e nao "em vigor desde".
export const SHEET_SNAPSHOT = '2026-10-15';

export const VERSIONS = {
  "ynerluz-bt": { k: 0.02, cgs: 0.025, loss: 0.1531275537, formula: "ynerluz" },
  "ynerluz-mt": { k: 0.02, cgs: 0.025, loss: 0.07127022935, formula: "ynerluz" },
  "luzigas-ceme-bt": { k: 0.05, cgs: 0.02 },
  "luzigas-ceme-mt": { k: 0.05, cgs: 0.02 },
  "luzigas-casa-bt": { k: 0.005, cgs: 0.02 },
  "luzigas-casa-mt": { k: 0.005, cgs: 0.02 },
  "luzigas-k0010-bt": { k: 0.01, cgs: 0.02 },
  "luzigas-k0010-mt": { k: 0.01, cgs: 0.02 },
  "meo-dinamica-bt": { k: 0.065, cgs: 0.0 },
  "meo-dinamica-mt": { k: 0.065, cgs: 0.0 },
};

export function seed(db) {
  // seed() corre em cada arranque do servidor, nao so na base nova. E
  // tariff_version nao tinha chave unica nenhuma, por isso cada arranque
  // inseria OUTRA versao com os mesmos dados — 128 duplicados por arranque
  // (nao se via porque o ORDER BY valid_from DESC LIMIT 1 parte num empate e
  // os precos sao iguais, mas "qual e a versao actual" deixava de ter
  // resposta). A correcao e uma chave unica (tariff_id, valid_from) — que e o
  // que ja queremos para o versionamento: uma versao por tarifario e data.
  // A limpeza vai primeiro, senao o CREATE INDEX rebenta com os duplicados.
  db.exec(`DELETE FROM price_component WHERE tariff_version_id IN
    (SELECT id FROM tariff_version WHERE id NOT IN
      (SELECT MAX(id) FROM tariff_version GROUP BY tariff_id, valid_from))`);
  db.exec(`DELETE FROM tariff_version WHERE id NOT IN
    (SELECT MAX(id) FROM tariff_version GROUP BY tariff_id, valid_from)`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_tariff_version ON tariff_version(tariff_id, valid_from)');

  // Idempotente E convergente (igual ao seed.postgres.js): as linhas
  // existentes são atualizadas para o que está no código. Antes era
  // INSERT OR IGNORE — um no-op em BD já povoada, portanto corrigir um preço
  // não chegava a produção no redeploy seguinte. As chaves mantêm-se, logo
  // re-correr o seed nunca duplica linhas.
  const insCeme = db.prepare(`INSERT INTO ceme (id,name,brand_color,website) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, brand_color=excluded.brand_color, website=excluded.website`);
  for (const c of CEMES) insCeme.run(...c);
  const insT = db.prepare(`INSERT INTO tariff
    (id,ceme_id,name,kind,voltage,schedule,cycle,green,access,popular,bundle,regions,source_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      ceme_id=excluded.ceme_id, name=excluded.name, kind=excluded.kind,
      voltage=excluded.voltage, schedule=excluded.schedule, cycle=excluded.cycle,
      green=excluded.green, access=excluded.access, popular=excluded.popular,
      bundle=excluded.bundle, regions=excluded.regions, source_url=excluded.source_url`);
  // notes = NULL por omissao (a procedencia esta em `origin`); so lleva codigo
  // onde ha mesmo algo a dizer — ver NOTES.
  // valid_to fica de fora do UPDATE: é NULL no seed mas pode ter sido
  // fechado por um operador, e sobrepô-lo reabriria tarifários expirados.
  const insV = db.prepare(`INSERT INTO tariff_version
    (id,tariff_id,valid_from,valid_to,campaign,status,origin,k_index_eur_mwh,cgs_eur_mwh,omie_aggregation,notes)
    VALUES (NULL,?, ?, NULL, 0,'ACTIVE','SEED_' || ?,?,?, 'SPLIT_VAZIO_FORA',?)
    ON CONFLICT(tariff_id, valid_from) DO UPDATE SET
      status=excluded.status, origin=excluded.origin,
      k_index_eur_mwh=excluded.k_index_eur_mwh, cgs_eur_mwh=excluded.cgs_eur_mwh,
      omie_aggregation=excluded.omie_aggregation, notes=excluded.notes`);
  const insP = db.prepare(`INSERT INTO price_component (tariff_version_id,period,energy_eur_kwh,activation_eur,support_eur,iec_eur_kwh,energy_only_eur_kwh,tar_eur_kwh)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(tariff_version_id, period) DO UPDATE SET
      energy_eur_kwh=excluded.energy_eur_kwh, activation_eur=excluded.activation_eur,
      support_eur=excluded.support_eur, iec_eur_kwh=excluded.iec_eur_kwh,
      energy_only_eur_kwh=excluded.energy_only_eur_kwh, tar_eur_kwh=excluded.tar_eur_kwh`);
  try { db.exec('ALTER TABLE tariff ADD COLUMN bundle INTEGER DEFAULT 0'); } catch { /* já existe */ }
  try { db.exec('ALTER TABLE tariff ADD COLUMN regions TEXT DEFAULT \'CONT\''); } catch { /* já existe */ }
  try { db.exec('ALTER TABLE price_component ADD COLUMN energy_only_eur_kwh REAL'); } catch { /* já existe */ }
  try { db.exec('ALTER TABLE price_component ADD COLUMN tar_eur_kwh REAL'); } catch { /* já existe */ }
  for (const t of TARIFFS) {
    const [id, ceme, name, kind, volt, sched, cyc, green, access, pop, bundle, regions, prices, act, support, iec, est, url] = t;
    insT.run(id, ceme, name + (est && kind === 'FIXED' ? ' ~' : ''), kind, volt, sched, cyc, green, access, pop, bundle, regions, url);
    const v = VERSIONS[id] || {};
    insV.run(id, SHEET_SNAPSHOT, SHEET_SNAPSHOT, v.k ?? null, v.cgs ?? null, NOTES[id] ?? null);
    const vid = db.prepare('SELECT id FROM tariff_version WHERE tariff_id=? ORDER BY id DESC LIMIT 1').get(id).id;
    const split = SPLITS[id] || {};
    if (prices) for (const [per, val] of Object.entries(prices)) {
      const sp = split[per] || null;
      insP.run(vid, per, val, act, support, iec, sp ? sp.energy : null, sp ? sp.tar : null);
    }
    // INDEXED: o €/kWh é calculado em runtime, mas a ativação (EGME),
    // o apoio e o IEC são os mesmos — têm de vir da linha do sheet.
    else insP.run(vid, 'VAZIO', null, act, support, iec, null, null);
  }
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  const { mkdirSync } = await import('node:fs');
  const { readFileSync } = await import('node:fs');
  mkdirSync('./data', { recursive: true });
  const db = new DatabaseSync(process.env.DB_PATH || './data/ceme.db');
  db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  seed(db);
  console.log('seed ok:', db.prepare('SELECT COUNT(*) c FROM tariff').get().c, 'tarifários,', db.prepare('SELECT COUNT(*) c FROM ceme').get().c, 'CEME');
}
