// Seed completo para PostgreSQL: 24 CEME / 127 tarifários extraídos do sheet em 2026-10-15.
// (Okeana removida em 2026-10-18: última info de 2023, sem EGME discriminado.)
// Valores finais €/kWh (c/ TAR, s/ IVA). indexed: calculado em runtime.
// act = EGME, o valor que a CEME publica (só o miio não cobra).
import { readFile } from 'node:fs/promises';
import { query, run } from './pg.js';
import { SPLITS } from './seed.js';

const CEMES = [
  ['acp', "ACP", "#ac2925", "https://www.acp.pt/eletricos/app-e-cartao-acp-electric/para-socios-e-nao-socios"],
  ['atlante', "Atlante", "#45a267", "https://atlante.energy/pt-pt/tarifas-de-energia/"],
  ['bluecharge', "Bluecharge", "#5bc0de", "https://www.bluecharge.pt/cartao-bluecharge/"],
  ['charge2go', "Charge2Go", "#4ca541", "https://charge2go.pt/tarifarios/"],
  ['edp', "EDP Comercial", "#212e3e", "https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/"],
  ['enable', "Enable Mobility", "#75c080", "https://www.enable-mobility.com/condutores"],
  ['evaz', "eVaz Energy", "#a3d65c", "https://www.evaz.energy/solutions/plans/mobility/"],
  ['evio', "EVIO", "#888888", "https://www.gocharge.pt/pt/landing-pages/app/"],
  ['evpower', "EVPower", "#0073aa", "https://www.evpower.pt/particulares/"],
  ['ezu', "EZU", "#da3025", "https://ezu.pt/ceme"],
  ['factorenergia', "FactorEnergia", "#303030", "https://factorenergia.pt/servicos/cartao-mobilidade-eletrica/"],
  ['galp', "GALP Electric", "#e96224", "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ['goldenergy', "GoldEnergy", "#7edf9c", "https://goldenergy.pt/blog/mobilidade-eletrica/"],
  ['hgp', "High Green Power", "#90b742", "https://www.highgreenpower.pt/mobilidade-eletrica-setor-publico-mobi-e/"],
  ['iberdrola', "Iberdrola", "#00A443", "https://www.iberdrola.pt/casa/mobilidade-eletrica/carregar-fora-casa"],
  ['luzigas', "LUZiGÁS", "#87b9f9", "https://www.luzigas.pt/plano-mobilidade-eletrica/"],
  ['meo', "MEO Energia", "#00c34f", "https://www.meoenergia.pt/mobilidade-eletrica"],
  ['miio', "miio", "#318c88", "https://www.miio.com/pt/miio-one"],
  ['mobismart', "Mobismart", "#001c5c", "https://mobismart.pt/pedir-cartao/"],
  ['moeve', "Moeve (Cepsa)", "#31404e", "https://pt.moeveglobal.com/pt/utilizacao/produtos-servicos/carregamento-eletrico"],
  ['prio', "Prio", "#0095b1", "https://www.prio.pt/downloads/file422_pt.pdf"],
  ['repsol', "Repsol", "#f19208", "https://www.repsol.pt/particulares/estrada/mobilidade-eletrica/"],
  ['viaverde', "Via Verde", "#009c3b", "https://www.viaverde.pt/particulares/via-verde/servicos/via-verde-electric"],
  ['ynerluz', "Ynerluz", "#888888", "https://www.ynerluz.com/aderir-mobilidade-eletrica/"],
];

const TARIFFS = [
  ["atlante-bt-myatlanteac", "atlante", "myAtlante (AC)", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 1, 0, "CONT", {"VAZIO": 0.1266, "FORA_VAZIO": 0.2192}, 0.11, 0.0, 0.001, 0, "https://atlante.energy/pt-pt/tarifas-de-energia/"],
  ["atlante-mt-myatlanteac", "atlante", "myAtlante (AC)", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 1, 0, "CONT", {"VAZIO": 0.1157, "FORA_VAZIO": 0.1812}, 0.11, 0.0, 0.001, 0, "https://atlante.energy/pt-pt/tarifas-de-energia/"],
  ["atlante-bt-myatlantebus", "atlante", "myAtlante Business (AC)", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.1066, "FORA_VAZIO": 0.1992}, 0.11, 0.0, 0.001, 0, "https://atlante.energy/pt-pt/tarifas-de-energia/"],
  ["atlante-mt-myatlantebus", "atlante", "myAtlante Business (AC)", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.0957, "FORA_VAZIO": 0.1612}, 0.11, 0.0, 0.001, 0, "https://atlante.energy/pt-pt/tarifas-de-energia/"],
  ["bluecharge-bt-cartobluecha", "bluecharge", "Cartão Bluecharge", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", {"VAZIO": 0.249, "FORA_VAZIO": 0.269}, 0.1088, 0.0, 0.001, 0, "https://www.bluecharge.pt/cartao-bluecharge/"],
  ["bluecharge-mt-cartobluecha", "bluecharge", "Cartão Bluecharge", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", {"VAZIO": 0.249, "FORA_VAZIO": 0.269}, 0.1088, 0.0, 0.001, 0, "https://www.bluecharge.pt/cartao-bluecharge/"],
  ["bluecharge-bt-cartobluecha-2", "bluecharge", "Cartão Bluecharge", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 0, 0, "CONT", {"VAZIO": 0.249, "FORA_VAZIO": 0.269}, 0.1088, 0.0, 0.001, 0, "https://www.bluecharge.pt/cartao-bluecharge/"],
  ["bluecharge-mt-cartobluecha-2", "bluecharge", "Cartão Bluecharge", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 0, 0, "CONT", {"VAZIO": 0.249, "FORA_VAZIO": 0.269}, 0.1088, 0.0, 0.001, 0, "https://www.bluecharge.pt/cartao-bluecharge/"],
  ["moeve-bt-gow", "moeve", "GOW", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", {"VAZIO": 0.24, "FORA_VAZIO": 0.32}, 0.1088, 0.0, 0.001, 0, "https://pt.moeveglobal.com/pt/utilizacao/produtos-servicos/carregamento-eletrico"],
  ["moeve-mt-gow", "moeve", "GOW", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", {"VAZIO": 0.22, "FORA_VAZIO": 0.27}, 0.1088, 0.0, 0.001, 0, "https://pt.moeveglobal.com/pt/utilizacao/produtos-servicos/carregamento-eletrico"],
  ["charge2go-bt-ecogreen", "charge2go", "Eco Green", "FIXED", "BT", "BI_HORARIA", "DIARIO", 0, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.1963, "FORA_VAZIO": 0.2889}, 0.1572, 0.0, 0.001, 0, "https://charge2go.pt/tarifarios/"],
  ["charge2go-bt-ecogreen-2", "charge2go", "Eco Green", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 0, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.1963, "FORA_VAZIO": 0.2889}, 0.1572, 0.0, 0.001, 0, "https://charge2go.pt/tarifarios/"],
  ["charge2go-mt-ecogreen", "charge2go", "Eco Green", "FIXED", "MT", "BI_HORARIA", "DIARIO", 0, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.1854, "FORA_VAZIO": 0.2509}, 0.1572, 0.0, 0.001, 0, "https://charge2go.pt/tarifarios/"],
  ["charge2go-mt-ecogreen-2", "charge2go", "Eco Green", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 0, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.1854, "FORA_VAZIO": 0.2509}, 0.1572, 0.0, 0.001, 0, "https://charge2go.pt/tarifarios/"],
  ["viaverde-bt-viaverdeelec", "viaverde", "Via Verde Electric by ECOCHOICE", "FIXED", "BT", "BI_HORARIA", "DIARIO", 0, "AMBOS", 1, 0, "CONT", {"VAZIO": 0.1746, "FORA_VAZIO": 0.2672}, 0.1572, 0.0, 0.001, 0, "https://www.viaverde.pt/particulares/via-verde/servicos/via-verde-electric"],
  ["viaverde-bt-viaverdeelec-2", "viaverde", "Via Verde Electric by ECOCHOICE", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 0, "AMBOS", 1, 0, "CONT", {"VAZIO": 0.1746, "FORA_VAZIO": 0.2672}, 0.1572, 0.0, 0.001, 0, "https://www.viaverde.pt/particulares/via-verde/servicos/via-verde-electric"],
  ["viaverde-mt-viaverdeelec", "viaverde", "Via Verde Electric by ECOCHOICE", "FIXED", "MT", "BI_HORARIA", "DIARIO", 0, "AMBOS", 1, 0, "CONT", {"VAZIO": 0.1637, "FORA_VAZIO": 0.2292}, 0.1572, 0.0, 0.001, 0, "https://www.viaverde.pt/particulares/via-verde/servicos/via-verde-electric"],
  ["viaverde-mt-viaverdeelec-2", "viaverde", "Via Verde Electric by ECOCHOICE", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 0, "AMBOS", 1, 0, "CONT", {"VAZIO": 0.1637, "FORA_VAZIO": 0.2292}, 0.1572, 0.0, 0.001, 0, "https://www.viaverde.pt/particulares/via-verde/servicos/via-verde-electric"],
  ["edp-bt-cartoedp", "edp", "Cartão EDP Charge (Simples)", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 1, 0, "CONT", {"UNICO": 0.2678}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-mt-cartoedp", "edp", "Cartão EDP Charge (Simples)", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 1, 0, "CONT", {"UNICO": 0.2678}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-bt-cartoedp-2", "edp", "Cartão EDP Charge (Simples) Associados UVE (10%)", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 1, 1, "CONT", {"UNICO": 0.24102}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-mt-cartoedp-2", "edp", "Cartão EDP Charge (Simples) Associados UVE (10%)", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 1, 1, "CONT", {"UNICO": 0.24102}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-bt-cartoedp-3", "edp", "Cartão EDP Charge (Simples) Clientes energia (20%)", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 1, 1, "CONT", {"UNICO": 0.21424}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-mt-cartoedp-3", "edp", "Cartão EDP Charge (Simples) Clientes energia (20%)", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 1, 1, "CONT", {"UNICO": 0.21424}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-bt-cartoedp-4", "edp", "Cartão EDP Charge (Simples) Clientes energia / UVE (30%)", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", {"UNICO": 0.18746}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-mt-cartoedp-4", "edp", "Cartão EDP Charge (Simples) Clientes energia / UVE (30%)", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", {"UNICO": 0.18746}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-bt-cartoedp-5", "edp", "Cartão EDP Charge (Simples) Colaboradores (25%)", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", {"UNICO": 0.20085}, 0.1088, 0.0, 0.001, 0, ""],
  ["edp-mt-cartoedp-5", "edp", "Cartão EDP Charge (Simples) Colaboradores (25%)", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", {"UNICO": 0.20085}, 0.1088, 0.0, 0.001, 0, ""],
  ["edp-bt-cartoedp-6", "edp", "Cartão EDP Charge Frota (Simples)", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", {"UNICO": 0.2591}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/"],
  ["edp-mt-cartoedp-6", "edp", "Cartão EDP Charge Frota (Simples)", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", {"UNICO": 0.2591}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/"],
  ["edp-bt-cartoedp-7", "edp", "Cartão EDP Charge Frota (Simples) Clientes Energia", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", {"UNICO": 0.20728}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/"],
  ["edp-mt-cartoedp-7", "edp", "Cartão EDP Charge Frota (Simples) Clientes Energia", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", {"UNICO": 0.20728}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/"],
  ["edp-bt-cartoedp-8", "edp", "Cartão EDP Charge (Bi-Horário)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 0, "CONT", {"VAZIO": 0.1927, "FORA_VAZIO": 0.2826}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-mt-cartoedp-8", "edp", "Cartão EDP Charge (Bi-Horário)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 0, "CONT", {"VAZIO": 0.1927, "FORA_VAZIO": 0.2826}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-bt-cartoedp-9", "edp", "Cartão EDP Charge (Bi-Horário) Associados UVE (10%)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.17343, "FORA_VAZIO": 0.25434}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-mt-cartoedp-9", "edp", "Cartão EDP Charge (Bi-Horário) Associados UVE (10%)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.17343, "FORA_VAZIO": 0.25434}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-bt-cartoedp-10", "edp", "Cartão EDP Charge (Bi-Horário) Clientes energia (20%)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.15416, "FORA_VAZIO": 0.22608}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-mt-cartoedp-10", "edp", "Cartão EDP Charge (Bi-Horário) Clientes energia (20%)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.15416, "FORA_VAZIO": 0.22608}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-bt-cartoedp-11", "edp", "Cartão EDP Charge (Bi-Horário) Clientes energia / UVE (30%)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.13489, "FORA_VAZIO": 0.19782}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-mt-cartoedp-11", "edp", "Cartão EDP Charge (Bi-Horário) Clientes energia / UVE (30%)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.13489, "FORA_VAZIO": 0.19782}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/"],
  ["edp-bt-cartoedp-12", "edp", "Cartão EDP Charge (Bi-Horário) Colaboradores (25%)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.144525, "FORA_VAZIO": 0.21195}, 0.1088, 0.0, 0.001, 0, ""],
  ["edp-mt-cartoedp-12", "edp", "Cartão EDP Charge (Bi-Horário) Colaboradores (25%)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.144525, "FORA_VAZIO": 0.21195}, 0.1088, 0.0, 0.001, 0, ""],
  ["edp-bt-cartoedp-13", "edp", "Cartão EDP Charge (Bi-Horário) Frota", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.2121, "FORA_VAZIO": 0.2681}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/"],
  ["edp-mt-cartoedp-13", "edp", "Cartão EDP Charge (Bi-Horário) Frota", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.2121, "FORA_VAZIO": 0.2681}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/"],
  ["edp-bt-cartoedp-14", "edp", "Cartão EDP Charge (Bi-Horário) Frota Clientes Energia", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.16968, "FORA_VAZIO": 0.21448}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/"],
  ["edp-mt-cartoedp-14", "edp", "Cartão EDP Charge (Bi-Horário) Frota Clientes Energia", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.16968, "FORA_VAZIO": 0.21448}, 0.1088, 0.0, 0.001, 0, "https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/"],
  ["evpower-bt-cartoevpower", "evpower", "Cartão EVpower", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.1995, "FORA_VAZIO": 0.3144}, 0.1572, 0.0, 0.001, 0, "https://www.evpower.pt/particulares/"],
  ["evpower-mt-cartoevpower", "evpower", "Cartão EVpower", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.1848, "FORA_VAZIO": 0.2696}, 0.1572, 0.0, 0.001, 0, "https://www.evpower.pt/particulares/"],
  ["evaz-bt-planomovebas", "evaz", "Plano Move Base", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.169, "FORA_VAZIO": 0.2635}, 0.1088, 0.0, 0.001, 0, "https://www.evaz.energy/solutions/plans/mobility/"],
  ["evaz-mt-planomovebas", "evaz", "Plano Move Base", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.169, "FORA_VAZIO": 0.2635}, 0.1088, 0.0, 0.001, 0, "https://www.evaz.energy/solutions/plans/mobility/"],
  ["evaz-bt-planomovebas-2", "evaz", "Plano Move Base", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.169, "FORA_VAZIO": 0.2635}, 0.1088, 0.0, 0.001, 0, "https://www.evaz.energy/solutions/plans/mobility/"],
  ["evaz-mt-planomovebas-2", "evaz", "Plano Move Base", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.169, "FORA_VAZIO": 0.2635}, 0.1088, 0.0, 0.001, 0, "https://www.evaz.energy/solutions/plans/mobility/"],
  ["evaz-bt-planomovehom", "evaz", "Plano Move HOME", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 1, "CONT", {"VAZIO": 0.16055, "FORA_VAZIO": 0.250325}, 0.1088, 0.0, 0.001, 0, "https://www.evaz.energy/solutions/plans/mobility/"],
  ["evaz-mt-planomovehom", "evaz", "Plano Move HOME", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 1, "CONT", {"VAZIO": 0.16055, "FORA_VAZIO": 0.250325}, 0.1088, 0.0, 0.001, 0, "https://www.evaz.energy/solutions/plans/mobility/"],
  ["evaz-bt-planomovehom-2", "evaz", "Plano Move HOME", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "CARTAO", 0, 1, "CONT", {"VAZIO": 0.16055, "FORA_VAZIO": 0.250325}, 0.1088, 0.0, 0.001, 0, "https://www.evaz.energy/solutions/plans/mobility/"],
  ["evaz-mt-planomovehom-2", "evaz", "Plano Move HOME", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "CARTAO", 0, 1, "CONT", {"VAZIO": 0.16055, "FORA_VAZIO": 0.250325}, 0.1088, 0.0, 0.001, 0, "https://www.evaz.energy/solutions/plans/mobility/"],
  ["acp-bt-acpelectricb", "acp", "ACP Electric by EVIO - sócio ACP", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 1, "CONT", {"VAZIO": 0.1581, "FORA_VAZIO": 0.2507}, 0.15, 0.0, 0.001, 0, "https://www.acp.pt/eletricos/app-e-cartao-acp-electric/para-socios-e-nao-socios"],
  ["acp-mt-acpelectricb", "acp", "ACP Electric by EVIO - sócio ACP", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 1, "CONT", {"VAZIO": 0.1472, "FORA_VAZIO": 0.2127}, 0.15, 0.0, 0.001, 0, "https://www.acp.pt/eletricos/app-e-cartao-acp-electric/para-socios-e-nao-socios"],
  ["acp-bt-acpelectricb-2", "acp", "ACP Electric by EVIO - não sócio ACP", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", {"VAZIO": 0.1956, "FORA_VAZIO": 0.2882}, 0.15, 0.0, 0.001, 0, "https://www.acp.pt/eletricos/app-e-cartao-acp-electric/para-socios-e-nao-socios"],
  ["acp-mt-acpelectricb-2", "acp", "ACP Electric by EVIO - não sócio ACP", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", {"VAZIO": 0.1847, "FORA_VAZIO": 0.2502}, 0.15, 0.0, 0.001, 0, "https://www.acp.pt/eletricos/app-e-cartao-acp-electric/para-socios-e-nao-socios"],
  ["enable-bt-tarifasimple", "enable", "Tarifa Simples", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 1, 0, "CONT", {"UNICO": 0.21215}, 0.1088, 0.0, 0.001, 0, "https://www.enable-mobility.com/condutores"],
  ["enable-mt-tarifasimple", "enable", "Tarifa Simples", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 1, 0, "CONT", {"UNICO": 0.21215}, 0.1088, 0.0, 0.001, 0, "https://www.enable-mobility.com/condutores"],
  ["evio-bt-hyundaiblue", "evio", "Hyundai Blue", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.1956, "FORA_VAZIO": 0.2882}, 0.1572, 0.0, 0.001, 0, "https://ceme.go-evio.com/pt/site-ceme"],
  ["evio-mt-hyundaiblue", "evio", "Hyundai Blue", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.1847, "FORA_VAZIO": 0.2502}, 0.1572, 0.0, 0.001, 0, "https://ceme.go-evio.com/pt/site-ceme"],
  ["evio-bt-evio", "evio", "EVIO", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 0, "CONT", {"VAZIO": 0.1956, "FORA_VAZIO": 0.2882}, 0.15, 0.0, 0.001, 0, "https://ceme.go-evio.com/pt/site-ceme"],
  ["evio-mt-evio", "evio", "EVIO", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 0, "CONT", {"VAZIO": 0.1847, "FORA_VAZIO": 0.2502}, 0.15, 0.0, 0.001, 0, "https://ceme.go-evio.com/pt/site-ceme"],
  ["evio-bt-gochargeby", "evio", "Go.Charge by EVIO", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.1956, "FORA_VAZIO": 0.2882}, 0.1572, 0.0, 0.001, 0, "https://www.gocharge.pt/pt/landing-pages/app/"],
  ["evio-mt-gochargeby", "evio", "Go.Charge by EVIO", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.1847, "FORA_VAZIO": 0.2502}, 0.1572, 0.0, 0.001, 0, "https://www.gocharge.pt/pt/landing-pages/app/"],
  ["ezu-bt-tarifrioceme", "ezu", "Tarifário CEME", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.1766, "FORA_VAZIO": 0.2692}, 0.1088, 0.0, 0.001, 0, "https://ezu.pt/ceme"],
  ["ezu-mt-tarifrioceme", "ezu", "Tarifário CEME", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.1657, "FORA_VAZIO": 0.2312}, 0.1088, 0.0, 0.001, 0, "https://ezu.pt/ceme"],
  ["ezu-bt-abenergia", "ezu", "AB Energia", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 1, "CONT", {"VAZIO": 0.1256, "FORA_VAZIO": 0.2182}, 0.1088, 0.0, 0.001, 0, "https://ezu.pt/ceme"],
  ["ezu-mt-abenergia", "ezu", "AB Energia", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 1, "CONT", {"VAZIO": 0.1147, "FORA_VAZIO": 0.1802}, 0.1088, 0.0, 0.001, 0, "https://ezu.pt/ceme"],
  ["factorenergia-bt-vecard", "factorenergia", "VECARD", "FIXED", "BT", "BI_HORARIA", "DIARIO", 0, "CARTAO", 0, 1, "CONT", {"VAZIO": 0.19, "FORA_VAZIO": 0.295}, 0.1088, 0.0, 0.001, 0, "https://factorenergia.pt/servicos/cartao-mobilidade-eletrica/"],
  ["factorenergia-mt-vecard", "factorenergia", "VECARD", "FIXED", "MT", "BI_HORARIA", "DIARIO", 0, "CARTAO", 0, 1, "CONT", {"VAZIO": 0.19, "FORA_VAZIO": 0.295}, 0.1088, 0.0, 0.001, 0, "https://factorenergia.pt/servicos/cartao-mobilidade-eletrica/"],
  ["factorenergia-bt-vecard-2", "factorenergia", "VECARD", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 0, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.19, "FORA_VAZIO": 0.295}, 0.1088, 0.0, 0.001, 0, "https://factorenergia.pt/servicos/cartao-mobilidade-eletrica/"],
  ["factorenergia-mt-vecard-2", "factorenergia", "VECARD", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 0, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.19, "FORA_VAZIO": 0.295}, 0.1088, 0.0, 0.001, 0, "https://factorenergia.pt/servicos/cartao-mobilidade-eletrica/"],
  ["galp-bt-galpelectric", "galp", "Galp Electric Energia Verde", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 0, "CONT", {"VAZIO": 0.1954, "FORA_VAZIO": 0.2632}, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-mt-galpelectric", "galp", "Galp Electric Energia Verde", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 0, "CONT", {"VAZIO": 0.1954, "FORA_VAZIO": 0.2632}, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-bt-galpelectric-2", "galp", "Galp Electric Energia Verde", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 1, 0, "CONT", {"VAZIO": 0.1954, "FORA_VAZIO": 0.2632}, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-mt-galpelectric-2", "galp", "Galp Electric Energia Verde", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 1, 0, "CONT", {"VAZIO": 0.1954, "FORA_VAZIO": 0.2632}, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-bt-galpelectric-3", "galp", "Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar sem Wallbox (18% desconto)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 1, "CONT", {"VAZIO": 0.160228, "FORA_VAZIO": 0.215824}, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-mt-galpelectric-3", "galp", "Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar sem Wallbox (18% desconto)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 1, "CONT", {"VAZIO": 0.160228, "FORA_VAZIO": 0.215824}, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-bt-galpelectric-4", "galp", "Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar sem Wallbox (18% desconto)", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 1, 1, "CONT", {"VAZIO": 0.160228, "FORA_VAZIO": 0.215824}, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-mt-galpelectric-4", "galp", "Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar sem Wallbox (18% desconto)", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 1, 1, "CONT", {"VAZIO": 0.160228, "FORA_VAZIO": 0.215824}, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-bt-galpelectric-5", "galp", "Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar com Wallbox (20% desconto)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.15632, "FORA_VAZIO": 0.21056}, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-mt-galpelectric-5", "galp", "Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar com Wallbox (20% desconto)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.15632, "FORA_VAZIO": 0.21056}, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-bt-galpelectric-6", "galp", "Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar com Wallbox (20% desconto)", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.15632, "FORA_VAZIO": 0.21056}, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["galp-mt-galpelectric-6", "galp", "Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar com Wallbox (20% desconto)", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.15632, "FORA_VAZIO": 0.21056}, 0.1088, 0.0, 0.001, 0, "https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info"],
  ["goldenergy-bt-clientesgold", "goldenergy", "Clientes Goldenergy Comercialização", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", {"UNICO": 0.2222}, 0.1088, 0.0, 0.001, 0, "https://goldenergy.pt/blog/mobilidade-eletrica/"],
  ["goldenergy-mt-clientesgold", "goldenergy", "Clientes Goldenergy Comercialização", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 1, "CONT", {"UNICO": 0.2222}, 0.1088, 0.0, 0.001, 0, "https://goldenergy.pt/blog/mobilidade-eletrica/"],
  ["goldenergy-bt-noclientes", "goldenergy", "Não Clientes Goldenergy Comercialização", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 0, "CONT", {"UNICO": 0.2778}, 0.1088, 0.0, 0.001, 0, "https://goldenergy.pt/blog/mobilidade-eletrica/"],
  ["goldenergy-mt-noclientes", "goldenergy", "Não Clientes Goldenergy Comercialização", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "AMBOS", 0, 0, "CONT", {"UNICO": 0.2778}, 0.1088, 0.0, 0.001, 0, "https://goldenergy.pt/blog/mobilidade-eletrica/"],
  ["hgp-bt-cartoceme", "hgp", "Cartão CEME", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.2966, "FORA_VAZIO": 0.3892}, 0.1088, 0.0, 0.001, 0, "https://www.highgreenpower.pt/mobilidade-eletrica-setor-publico-mobi-e/"],
  ["hgp-mt-cartoceme", "hgp", "Cartão CEME", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.2857, "FORA_VAZIO": 0.3512}, 0.1088, 0.0, 0.001, 0, "https://www.highgreenpower.pt/mobilidade-eletrica-setor-publico-mobi-e/"],
  ["iberdrola-bt-cartomobilid", "iberdrola", "Cartão Mobilidade Elétrica", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "CARTAO", 1, 0, "CONT", {"UNICO": 0.2486}, 0.1088, 0.0, 0.001, 0, "https://www.iberdrola.pt/casa/mobilidade-eletrica/carregar-fora-casa"],
  ["iberdrola-mt-cartomobilid", "iberdrola", "Cartão Mobilidade Elétrica", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "CARTAO", 1, 0, "CONT", {"UNICO": 0.2486}, 0.1088, 0.0, 0.001, 0, "https://www.iberdrola.pt/casa/mobilidade-eletrica/carregar-fora-casa"],
  ["iberdrola-bt-clienteeletr", "iberdrola", "Cliente Eletricidade Iberdrola", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "CARTAO", 0, 1, "CONT", {"UNICO": 0.1989}, 0.1088, 0.0, 0.001, 0, "https://www.iberdrola.pt/casa/mobilidade-eletrica/carregar-fora-casa"],
  ["iberdrola-mt-clienteeletr", "iberdrola", "Cliente Eletricidade Iberdrola", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "CARTAO", 0, 1, "CONT", {"UNICO": 0.1989}, 0.1088, 0.0, 0.001, 0, "https://www.iberdrola.pt/casa/mobilidade-eletrica/carregar-fora-casa"],
  ["meo-bt-mobilidadeel", "meo", "Mobilidade Elétrica com Tarifa Fixa Colaboradores MEO only", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "CARTAO", 0, 1, "CONT", {"UNICO": 0.195}, 0.1088, 0.0, 0.001, 0, "https://www.meoenergia.pt/mobilidade-eletrica"],
  ["meo-mt-mobilidadeel", "meo", "Mobilidade Elétrica com Tarifa Fixa Colaboradores MEO only", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "CARTAO", 0, 1, "CONT", {"UNICO": 0.195}, 0.1088, 0.0, 0.001, 0, "https://www.meoenergia.pt/mobilidade-eletrica"],
  ["meo-bt-mobilidadeel-2", "meo", "Mobilidade Elétrica com Tarifa Fixa Cliente MEO Energia e tem MEO M5e/M4e", "FIXED", "BT", "SIMPLES", "SIMPLES", 1, "CARTAO", 0, 1, "CONT", {"UNICO": 0.225}, 0.1088, 0.0, 0.001, 0, "https://www.meoenergia.pt/mobilidade-eletrica"],
  ["meo-mt-mobilidadeel-2", "meo", "Mobilidade Elétrica com Tarifa Fixa Cliente MEO Energia e tem MEO M5e/M4e", "FIXED", "MT", "SIMPLES", "SIMPLES", 1, "CARTAO", 0, 1, "CONT", {"UNICO": 0.225}, 0.1088, 0.0, 0.001, 0, "https://www.meoenergia.pt/mobilidade-eletrica"],
  ["miio-bt-miiobihor", "miio", "miio (Bi-Horário Semanal) sem subscrição", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 1, 0, "CONT", {"VAZIO": 0.2666, "FORA_VAZIO": 0.3592}, 0.0, 0.0, 0.001, 0, "https://www.miio.com/pt/miio-one"],
  ["miio-mt-miiobihor", "miio", "miio (Bi-Horário Semanal) sem subscrição", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 1, 0, "CONT", {"VAZIO": 0.2557, "FORA_VAZIO": 0.3212}, 0.0, 0.0, 0.001, 0, "https://www.miio.com/pt/miio-one"],
  ["miio-bt-miioonebi", "miio", "miio one (Bi-Horário Semanal) subscrição", "FIXED", "BT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.1966, "FORA_VAZIO": 0.2892}, 0.0, 0.0, 0.001, 0, "https://www.miio.com/pt/miio-one"],
  ["miio-mt-miioonebi", "miio", "miio one (Bi-Horário Semanal) subscrição", "FIXED", "MT", "BI_HORARIA", "SEMANAL", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.1857, "FORA_VAZIO": 0.2512}, 0.0, 0.0, 0.001, 0, "https://www.miio.com/pt/miio-one"],
  ["miio-bt-miiobihor-2", "miio", "miio (Bi-Horário Diário) sem subscrição", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", {"VAZIO": 0.2666, "FORA_VAZIO": 0.3592}, 0.0, 0.0, 0.001, 0, "https://www.miio.com/pt/miio-one"],
  ["miio-mt-miiobihor-2", "miio", "miio (Bi-Horário Diário) sem subscrição", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", {"VAZIO": 0.2557, "FORA_VAZIO": 0.3212}, 0.0, 0.0, 0.001, 0, "https://www.miio.com/pt/miio-one"],
  ["miio-bt-miioonebi-2", "miio", "miio one (Bi-Horário Diário) subscrição", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.1966, "FORA_VAZIO": 0.2892}, 0.0, 0.0, 0.001, 0, "https://www.miio.com/pt/miio-one"],
  ["miio-mt-miioonebi-2", "miio", "miio one (Bi-Horário Diário) subscrição", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 1, "CONT", {"VAZIO": 0.1857, "FORA_VAZIO": 0.2512}, 0.0, 0.0, 0.001, 0, "https://www.miio.com/pt/miio-one"],
  ["mobismart-bt-cartode", "mobismart", "Cartão de carregamento público e privado MOBISMART (pós-pago)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 0, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.2266, "FORA_VAZIO": 0.3692}, 0.1088, 0.0, 0.001, 0, "https://mobismart.pt/pedir-cartao/"],
  ["mobismart-mt-cartode", "mobismart", "Cartão de carregamento público e privado MOBISMART (pós-pago)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 0, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.2157, "FORA_VAZIO": 0.3312}, 0.1088, 0.0, 0.001, 0, "https://mobismart.pt/pedir-cartao/"],
  ["mobismart-bt-cartode-2", "mobismart", "Cartão de carregamento público e privado MOBISMART (pré-pago)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 0, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.2766, "FORA_VAZIO": 0.4192}, 0.1088, 0.0, 0.001, 0, "https://mobismart.pt/pedir-cartao/"],
  ["mobismart-mt-cartode-2", "mobismart", "Cartão de carregamento público e privado MOBISMART (pré-pago)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 0, "CARTAO", 0, 0, "CONT", {"VAZIO": 0.2657, "FORA_VAZIO": 0.3812}, 0.1088, 0.0, 0.001, 0, "https://mobismart.pt/pedir-cartao/"],
  ["prio-bt-prioelectric", "prio", "Prio Electric (EUR/kWh)", "FIXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 0, "CONT", {"VAZIO": 0.1765, "FORA_VAZIO": 0.2591}, 0.1088, 0.0, 0.001, 0, "https://www.prio.pt/downloads/file422_pt.pdf"],
  ["prio-mt-prioelectric", "prio", "Prio Electric (EUR/kWh)", "FIXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 1, 0, "CONT", {"VAZIO": 0.1656, "FORA_VAZIO": 0.2211}, 0.1088, 0.0, 0.001, 0, "https://www.prio.pt/downloads/file422_pt.pdf"],
  ["repsol-bt-pessoassingu", "repsol", "Pessoas Singulares", "FIXED", "BT", "SIMPLES", "SIMPLES", 0, "CARTAO", 0, 0, "CONT", {"UNICO": 0.2868}, 0.1088, 0.0, 0.001, 0, "https://www.repsol.pt/particulares/estrada/mobilidade-eletrica/"],
  ["repsol-mt-pessoassingu", "repsol", "Pessoas Singulares", "FIXED", "MT", "SIMPLES", "SIMPLES", 0, "CARTAO", 0, 0, "CONT", {"UNICO": 0.2868}, 0.1088, 0.0, 0.001, 0, "https://www.repsol.pt/particulares/estrada/mobilidade-eletrica/"],
  ["ynerluz-bt", "ynerluz", "Mobilidade Elétrica", "INDEXED", "BT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", null, 0.1088, 0.0, 0.001, 0, "https://www.ynerluz.com/aderir-mobilidade-eletrica/"],
  ["ynerluz-mt", "ynerluz", "Mobilidade Elétrica", "INDEXED", "MT", "BI_HORARIA", "DIARIO", 1, "AMBOS", 0, 0, "CONT", null, 0.1088, 0.0, 0.001, 0, "https://www.ynerluz.com/aderir-mobilidade-eletrica/"],
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

export async function seed() {
  // Idempotente E convergente: as linhas existentes são atualizadas para o
  // que está no código. Antes era tudo `DO NOTHING`, o que tornava o seed um
  // no-op em qualquer BD já povoada: corrigir um preço no código e voltar a
  // fazer deploy não mudava nada em produção, sem qualquer aviso.
  // As chaves (id / valid_from / period) mantêm-se, portanto re-correr o
  // seed nunca duplica linhas.

  // ceme
  for (const c of CEMES) {
    await query(
      `INSERT INTO ceme (id, name, brand_color, website) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         brand_color = EXCLUDED.brand_color,
         website = EXCLUDED.website`,
      c
    );
  }

  // tariff
  for (const t of TARIFFS) {
    const [id, ceme, name, kind, volt, sched, cyc, green, access, pop, bundle, regions, prices, act, support, iec, est, url] = t;
    await query(
      `INSERT INTO tariff (id, ceme_id, name, kind, voltage, schedule, cycle, green, access, popular, bundle, regions, source_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
         ceme_id = EXCLUDED.ceme_id,
         name = EXCLUDED.name,
         kind = EXCLUDED.kind,
         voltage = EXCLUDED.voltage,
         schedule = EXCLUDED.schedule,
         cycle = EXCLUDED.cycle,
         green = EXCLUDED.green,
         access = EXCLUDED.access,
         popular = EXCLUDED.popular,
         bundle = EXCLUDED.bundle,
         regions = EXCLUDED.regions,
         source_url = EXCLUDED.source_url`,
      [id, ceme, name + (est && kind === 'FIXED' ? ' ~' : ''), kind, volt, sched, cyc, green, access, pop, bundle, regions, url]
    );
  }

  // tariff_version
  for (const t of TARIFFS) {
    const [id] = t;
    const v = VERSIONS[id] || {};
    await query(
      `INSERT INTO tariff_version (tariff_id, valid_from, valid_to, campaign, status, origin, k_index_eur_mwh, cgs_eur_mwh, omie_aggregation, notes)
       VALUES ($1, $2, NULL, 0, 'ACTIVE', $3, $4, $5, 'SPLIT_VAZIO_FORA', $6)
       ON CONFLICT (tariff_id, valid_from) DO UPDATE SET
         status = EXCLUDED.status,
         origin = EXCLUDED.origin,
         k_index_eur_mwh = EXCLUDED.k_index_eur_mwh,
         cgs_eur_mwh = EXCLUDED.cgs_eur_mwh,
         omie_aggregation = EXCLUDED.omie_aggregation,
         notes = EXCLUDED.notes`,
      [id, SHEET_SNAPSHOT, 'SEED_' + id, v.k ?? null, v.cgs ?? null, NOTES[id] ?? null]
    );
  }

  // price_component
  for (const t of TARIFFS) {
    const [id, , , , , , , , , , , , prices, act, support, iec] = t;
    const v = VERSIONS[id] || {};
    const row = await query(
      `SELECT id FROM tariff_version WHERE tariff_id = $1 AND valid_from = $2`,
      [id, SHEET_SNAPSHOT]
    );
    if (row.length === 0) continue;
    const vid = row[0].id;

    if (prices) {
      for (const [per, val] of Object.entries(prices)) {
        const sp = (SPLITS[id] || {})[per] || null;
        await query(
          `INSERT INTO price_component (tariff_version_id, period, energy_eur_kwh, activation_eur, support_eur, iec_eur_kwh, energy_only_eur_kwh, tar_eur_kwh)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (tariff_version_id, period) DO UPDATE SET
             energy_eur_kwh = EXCLUDED.energy_eur_kwh,
             activation_eur = EXCLUDED.activation_eur,
             support_eur = EXCLUDED.support_eur,
             iec_eur_kwh = EXCLUDED.iec_eur_kwh,
             energy_only_eur_kwh = EXCLUDED.energy_only_eur_kwh,
             tar_eur_kwh = EXCLUDED.tar_eur_kwh`,
          [vid, per, val, act, support, iec, sp ? sp.energy : null, sp ? sp.tar : null]
        );
      }
    } else {
      await query(
        `INSERT INTO price_component (tariff_version_id, period, energy_eur_kwh, activation_eur, support_eur, iec_eur_kwh, energy_only_eur_kwh, tar_eur_kwh)
         VALUES ($1, $2, NULL, $3, $4, $5, NULL, NULL)
         ON CONFLICT (tariff_version_id, period) DO UPDATE SET
           energy_eur_kwh = EXCLUDED.energy_eur_kwh,
           activation_eur = EXCLUDED.activation_eur,
           support_eur = EXCLUDED.support_eur,
           iec_eur_kwh = EXCLUDED.iec_eur_kwh,
           energy_only_eur_kwh = EXCLUDED.energy_only_eur_kwh,
           tar_eur_kwh = EXCLUDED.tar_eur_kwh`,
        [vid, 'VAZIO', act, support, iec]
      );
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('seed.postgres.js')) {
  // Aplica o schema primeiro: correr `node seed.postgres.js` contra uma BD
  // vazia falhava com "relation does not exist", porque o schema só era
  // aplicado pelo server.js no arranque. Idempotente (CREATE TABLE IF NOT
  // EXISTS), portanto correr novamente é seguro.
  //
  // E depois as colunas em falta: o `CREATE TABLE IF NOT EXISTS` não as
  // acrescenta a uma tabela que já existe, e sem esta migração o seed
  // rebentava contra a forma antiga da BD ("column ... does not exist").
  const schemaSql = await readFile(
    new URL('./schema.postgres.sql', import.meta.url),
    'utf8'
  );

  run(schemaSql)
    .then(async () => {
      const { migrateAddedColumns } = await import('./migrate.js');
      for (const n of await migrateAddedColumns()) console.warn(`migração: ${n}`);
    })
    .then(() => seed())
    .then(async () => {
      const cemeCount = await query('SELECT COUNT(*) c FROM ceme');
      const tariffCount = await query('SELECT COUNT(*) c FROM tariff');
      console.log('seed ok:', tariffCount[0].c, 'tarifários,', cemeCount[0].c, 'CEME');
      process.exit(0);
    })
    .catch((err) => {
      console.error('seed falhou:', err);
      process.exit(1);
    });
}
