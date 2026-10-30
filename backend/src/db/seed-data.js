// Os dados de arranque: CEME, tarifários e preços. Só dados; quem os grava
// na BD é o seed.js.
//
// Para corrigires um preço, mudas aqui, fazes deploy e a BD apanha a
// mudança no arranque seguinte. Os preços vêm das páginas públicas de cada
// CEME; o procedimento de verificação está em .opencode/commands/ceme-check.md.

// Os CEME (as empresas que vendem a energia). `brand` é a cor da marca, que
// a interface usa nos cartões.
export const CEMES = [
  { id: 'acp', name: 'ACP', brand: '#ac2925', website: 'https://www.acp.pt/veiculos/eletricos/app-e-cartao-acp-electric/para-socios-e-nao-socios' },
  { id: 'atlante', name: 'Atlante', brand: '#45a267', website: 'https://atlante.energy/pt-pt/tarifas-de-energia/' },
  { id: 'charge2go', name: 'Charge2Go', brand: '#4ca541', website: 'https://charge2go.pt/tarifarios/' },
  { id: 'edp', name: 'EDP Comercial', brand: '#212e3e', website: 'https://www.edp.pt/particulares/servicos/mobilidade-eletrica/carregar-fora-de-casa/' },
  { id: 'enable', name: 'Enable Mobility', brand: '#75c080', website: 'https://www.enable-mobility.com/condutores' },
  { id: 'evaz', name: 'eVaz Energy', brand: '#a3d65c', website: 'https://www.evaz.energy/solutions/plans/mobility/' },
  { id: 'evio', name: 'EVIO', brand: '#888888', website: 'https://ceme.go-evio.com/pt/site-ceme' },
  { id: 'ezu', name: 'EZU', brand: '#da3025', website: 'https://ezu.pt/ceme' },
  { id: 'galp', name: 'GALP Electric', brand: '#e96224', website: 'https://galp.com/pt/pt/particulares/estrada/cartao-galpelectric-info' },
  { id: 'goldenergy', name: 'GoldEnergy', brand: '#7edf9c', website: 'https://goldenergy.pt/mobilidade-eletrica/' },
  { id: 'hgp', name: 'High Green Power', brand: '#90b742', website: 'https://www.highgreenpower.pt/' },
  { id: 'iberdrola', name: 'Iberdrola', brand: '#00A443', website: 'https://www.iberdrola.pt/casa/mobilidade-eletrica/carregar-fora-casa' },
  { id: 'luzigas', name: 'LUZiGÁS', brand: '#87b9f9', website: 'https://www.luzigas.pt/plano-mobilidade-eletrica/' },
  { id: 'meo', name: 'MEO Energia', brand: '#00c34f', website: 'https://www.meoenergia.pt/mobilidade-eletrica' },
  { id: 'miio', name: 'miio', brand: '#318c88', website: 'https://www.miio.com/pt/prices/charging' },
  { id: 'moeve', name: 'Moeve (Cepsa)', brand: '#31404e', website: 'https://pt.moeveglobal.com/pt/utilizacao/produtos-servicos/carregamento-eletrico' },
  { id: 'prio', name: 'Prio', brand: '#0095b1', website: 'https://www.prio.pt/downloads/file422_pt.pdf' },
  { id: 'repsol', name: 'Repsol', brand: '#f19208', website: 'https://www.repsol.pt/particulares/estrada/mobilidade-eletrica/' },
  { id: 'viaverde', name: 'Via Verde', brand: '#009c3b', website: 'https://www.viaverde.pt/particulares/via-verde/servicos/via-verde-electric' },
  { id: 'ynerluz', name: 'Ynerluz', brand: '#888888', website: 'https://www.ynerluz.com/aderir-mobilidade-eletrica/' },
];

// O IEC (imposto especial sobre a electricidade), em €/kWh. Todos os
// tarifários usam este valor salvo se tiverem `iec` próprio.
export const IEC = 0.001;

// O preço final partido em energia + TAR, por período, para os tarifários
// em que o CEME publica a separação (ou ela se tira sem ambiguidade). Onde
// não há entrada, a interface mostra só o total "energia + TAR".
//
// O `tar` de cada período é o que o CEME usou na conta dele, não o da tabela
// `tar`: se um dia não baterem certo, fica à vista em vez de escondido.
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
  // Enable: publica só a energia (um valor no Continente, outro nas ilhas,
  // vê REGION_SPLITS) e diz que exclui TAR, EGME, IEC e IVA. O final é
  // energia + TAR, no ciclo bi-horário semanal.
  'enable-bt-tarifasimple': { FORA_VAZIO: { energy: 0.12, tar: 0.1192 }, VAZIO: { energy: 0.12, tar: 0.0266 } },
  'enable-mt-tarifasimple': { FORA_VAZIO: { energy: 0.12, tar: 0.0812 }, VAZIO: { energy: 0.12, tar: 0.0157 } },
  'evio-bt-evio': { FORA_VAZIO: { energy: 0.169, tar: 0.1192 }, VAZIO: { energy: 0.169, tar: 0.0266 } },
  'evio-bt-gochargeby': { FORA_VAZIO: { energy: 0.169, tar: 0.1192 }, VAZIO: { energy: 0.169, tar: 0.0266 } },
  'evio-mt-evio': { FORA_VAZIO: { energy: 0.169, tar: 0.0812 }, VAZIO: { energy: 0.169, tar: 0.0157 } },
  'evio-mt-gochargeby': { FORA_VAZIO: { energy: 0.169, tar: 0.0812 }, VAZIO: { energy: 0.169, tar: 0.0157 } },
  'ezu-bt-tarifrioceme': { FORA_VAZIO: { energy: 0.15, tar: 0.1192 }, VAZIO: { energy: 0.15, tar: 0.0266 } },
  'ezu-mt-tarifrioceme': { FORA_VAZIO: { energy: 0.15, tar: 0.0812 }, VAZIO: { energy: 0.15, tar: 0.0157 } },
  'hgp-bt-cartoceme': { FORA_VAZIO: { energy: 0.27, tar: 0.1192 }, VAZIO: { energy: 0.27, tar: 0.0266 } },
  'hgp-mt-cartoceme': { FORA_VAZIO: { energy: 0.27, tar: 0.0812 }, VAZIO: { energy: 0.27, tar: 0.0157 } },
  'prio-bt-prioelectric': { FORA_VAZIO: { energy: 0.1399, tar: 0.1192 }, VAZIO: { energy: 0.1499, tar: 0.0266 } },
  'prio-mt-prioelectric': { FORA_VAZIO: { energy: 0.1399, tar: 0.0812 }, VAZIO: { energy: 0.1499, tar: 0.0157 } },
  'viaverde-bt-viaverdeelec': { FORA_VAZIO: { energy: 0.148, tar: 0.1192 }, VAZIO: { energy: 0.148, tar: 0.0266 } },
  'viaverde-bt-viaverdeelec-2': { FORA_VAZIO: { energy: 0.148, tar: 0.1192 }, VAZIO: { energy: 0.148, tar: 0.0266 } },
  'viaverde-mt-viaverdeelec': { FORA_VAZIO: { energy: 0.148, tar: 0.0812 }, VAZIO: { energy: 0.148, tar: 0.0157 } },
  'viaverde-mt-viaverdeelec-2': { FORA_VAZIO: { energy: 0.148, tar: 0.0812 }, VAZIO: { energy: 0.148, tar: 0.0157 } },
  // ACP não-sócio e Hyundai Blue usam o preço da EVIO, logo a mesma separação.
  'acp-bt-acpelectricb-2': { FORA_VAZIO: { energy: 0.169, tar: 0.1192 }, VAZIO: { energy: 0.169, tar: 0.0266 } },
  'acp-mt-acpelectricb-2': { FORA_VAZIO: { energy: 0.169, tar: 0.0812 }, VAZIO: { energy: 0.169, tar: 0.0157 } },
  'evio-bt-hyundaiblue': { FORA_VAZIO: { energy: 0.169, tar: 0.1192 }, VAZIO: { energy: 0.169, tar: 0.0266 } },
  'evio-mt-hyundaiblue': { FORA_VAZIO: { energy: 0.169, tar: 0.0812 }, VAZIO: { energy: 0.169, tar: 0.0157 } },
  // miio: energia = final − TAR.
  'miio-bt-miiobihor': { FORA_VAZIO: { energy: 0.24, tar: 0.1192 }, VAZIO: { energy: 0.24, tar: 0.0266 } },
  'miio-bt-miiobihor-2': { FORA_VAZIO: { energy: 0.24, tar: 0.1192 }, VAZIO: { energy: 0.24, tar: 0.0266 } },
  'miio-bt-miioonebi': { FORA_VAZIO: { energy: 0.17, tar: 0.1192 }, VAZIO: { energy: 0.17, tar: 0.0266 } },
  'miio-bt-miioonebi-2': { FORA_VAZIO: { energy: 0.17, tar: 0.1192 }, VAZIO: { energy: 0.17, tar: 0.0266 } },
  'miio-mt-miiobihor': { FORA_VAZIO: { energy: 0.24, tar: 0.0812 }, VAZIO: { energy: 0.24, tar: 0.0157 } },
  'miio-mt-miiobihor-2': { FORA_VAZIO: { energy: 0.24, tar: 0.0812 }, VAZIO: { energy: 0.24, tar: 0.0157 } },
  'miio-mt-miioonebi': { FORA_VAZIO: { energy: 0.17, tar: 0.0812 }, VAZIO: { energy: 0.17, tar: 0.0157 } },
  'miio-mt-miioonebi-2': { FORA_VAZIO: { energy: 0.17, tar: 0.0812 }, VAZIO: { energy: 0.17, tar: 0.0157 } },
};

// Preços próprios das ilhas, só para os CEME que cobram diferente lá. Mesma
// forma que SPLITS, mas com a região à frente. O seed calcula o preço final
// (energia + TAR, com regionFinal) e grava em `price_component_region`.
// A TAR é a mesma nas três regiões (docs/07-ilhas.md).
export const REGION_SPLITS = {
  'enable-bt-tarifasimple': {
    MAD: { VAZIO: { energy: 0.15, tar: 0.0266 }, FORA_VAZIO: { energy: 0.15, tar: 0.1192 } },
    AZO: { VAZIO: { energy: 0.15, tar: 0.0266 }, FORA_VAZIO: { energy: 0.15, tar: 0.1192 } },
  },
  'enable-mt-tarifasimple': {
    MAD: { VAZIO: { energy: 0.15, tar: 0.0157 }, FORA_VAZIO: { energy: 0.15, tar: 0.0812 } },
    AZO: { VAZIO: { energy: 0.15, tar: 0.0157 }, FORA_VAZIO: { energy: 0.15, tar: 0.0812 } },
  },
};

// Preço final de uma linha de REGION_SPLITS: energia + TAR, arredondado
// para cima a 4 casas.
export const regionFinal = (energy, tar) => Math.ceil((energy + tar) * 10000 - 1e-9) / 10000;

// Os tarifários, um objecto por tarifário:
//   id        identificador único (ceme-tensão-nome)
//   ceme      id do CEME (vê CEMES)
//   name      o nome que o CEME publica
//   kind      FIXED (preço fixo) ou INDEXED (segue o OMIE)
//   voltage   BT (baixa tensão) ou MT (média tensão)
//   schedule  SIMPLES (um preço) ou BI_HORARIA (vazio / fora de vazio)
//   cycle     DIARIO, SEMANAL ou SIMPLES (vê engine/regions.js)
//   access    como se paga: CARTAO (só cartão) ou AMBOS (cartão e app)
//   green     true se a energia é 100 % renovável
//   popular   true se é um dos mais usados (filtro "populares")
//   bundle    true se o preço exige outra relação com o CEME (ser cliente
//             de casa, sócio, colaborador…): o filtro "com condições"
//   regions   onde é vendido (CONT,MAD,AZO); só informação. Por omissão CONT
//   prices    { VAZIO, FORA_VAZIO } ou { UNICO } em €/kWh FINAL, com a TAR e
//             sem IVA; null nos indexados (calculados na hora)
//   act       taxa de activação por carregamento, em €, tal como o CEME a
//             publica (vê "activation_stale" em docs/04)
//   support   apoio por carregamento, em €. Por omissão 0
//   iec       imposto especial sobre a electricidade, €/kWh. Por omissão
//             IEC (o valor legal)
//   est       true se o preço de vazio é estimado e não publicado pelo CEME:
//             o nome ganha um " ~" no fim
//   url       a página onde o preço está publicado, se não for o `website`
//             do CEME (vê CEMES)
//   newCustomers  true se só o tem quem adere ao CEME
//   from, to  só nas campanhas com datas: o primeiro e o último dia em que
//             o preço vale, inclusive. Fora delas o simulador não o mostra
// Os campos true/false que faltam são false.
// Os preços finais têm no máximo 4 casas decimais, arredondados para cima
// quando a fonte tem mais (nunca subestimar o custo).
export const TARIFFS = [
  // (AC) = corrente alternada. Vê AC_DC_FLAT em NOTES.
  { id: 'atlante-bt-myatlanteac', ceme: 'atlante', name: 'myAtlante (AC)', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', green: true, popular: true, prices: { VAZIO: 0.1466, FORA_VAZIO: 0.2392 }, act: 0.11 },
  { id: 'atlante-mt-myatlanteac', ceme: 'atlante', name: 'myAtlante (AC)', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', green: true, popular: true, prices: { VAZIO: 0.1357, FORA_VAZIO: 0.2012 }, act: 0.11 },
  { id: 'atlante-bt-myatlantebus', ceme: 'atlante', name: 'myAtlante Business (AC)', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.1066, FORA_VAZIO: 0.1992 }, act: 0.11 },
  { id: 'atlante-mt-myatlantebus', ceme: 'atlante', name: 'myAtlante Business (AC)', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.0957, FORA_VAZIO: 0.1612 }, act: 0.11 },
  { id: 'moeve-bt-gow', ceme: 'moeve', name: 'GOW', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, prices: { VAZIO: 0.24, FORA_VAZIO: 0.32 }, act: 0.1088 },
  { id: 'moeve-mt-gow', ceme: 'moeve', name: 'GOW', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, prices: { VAZIO: 0.22, FORA_VAZIO: 0.27 }, act: 0.1088 },
  { id: 'charge2go-bt-ecogreen', ceme: 'charge2go', name: 'Eco Green', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'CARTAO', prices: { VAZIO: 0.1963, FORA_VAZIO: 0.2889 }, act: 0.1088 },
  { id: 'charge2go-bt-ecogreen-2', ceme: 'charge2go', name: 'Eco Green', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'CARTAO', prices: { VAZIO: 0.1963, FORA_VAZIO: 0.2889 }, act: 0.1088 },
  { id: 'charge2go-mt-ecogreen', ceme: 'charge2go', name: 'Eco Green', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'CARTAO', prices: { VAZIO: 0.1854, FORA_VAZIO: 0.2509 }, act: 0.1088 },
  { id: 'charge2go-mt-ecogreen-2', ceme: 'charge2go', name: 'Eco Green', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'CARTAO', prices: { VAZIO: 0.1854, FORA_VAZIO: 0.2509 }, act: 0.1088 },
  { id: 'viaverde-bt-viaverdeelec', ceme: 'viaverde', name: 'Via Verde Electric by ECOCHOICE', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', popular: true, prices: { VAZIO: 0.1746, FORA_VAZIO: 0.2672 }, act: 0.1572 },
  { id: 'viaverde-bt-viaverdeelec-2', ceme: 'viaverde', name: 'Via Verde Electric by ECOCHOICE', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', popular: true, prices: { VAZIO: 0.1746, FORA_VAZIO: 0.2672 }, act: 0.1572 },
  { id: 'viaverde-mt-viaverdeelec', ceme: 'viaverde', name: 'Via Verde Electric by ECOCHOICE', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', popular: true, prices: { VAZIO: 0.1637, FORA_VAZIO: 0.2292 }, act: 0.1572 },
  { id: 'viaverde-mt-viaverdeelec-2', ceme: 'viaverde', name: 'Via Verde Electric by ECOCHOICE', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', popular: true, prices: { VAZIO: 0.1637, FORA_VAZIO: 0.2292 }, act: 0.1572 },
  { id: 'edp-bt-cartoedp', ceme: 'edp', name: 'Cartão EDP Charge (Simples)', kind: 'FIXED', voltage: 'BT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', green: true, popular: true, prices: { UNICO: 0.2678 }, act: 0.1088 },
  { id: 'edp-mt-cartoedp', ceme: 'edp', name: 'Cartão EDP Charge (Simples)', kind: 'FIXED', voltage: 'MT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', green: true, popular: true, prices: { UNICO: 0.2678 }, act: 0.1088 },
  { id: 'edp-bt-cartoedp-2', ceme: 'edp', name: 'Cartão EDP Charge (Simples) Associados UVE (10%)', kind: 'FIXED', voltage: 'BT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', green: true, popular: true, bundle: true, prices: { UNICO: 0.2411 }, act: 0.1088 },
  { id: 'edp-mt-cartoedp-2', ceme: 'edp', name: 'Cartão EDP Charge (Simples) Associados UVE (10%)', kind: 'FIXED', voltage: 'MT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', green: true, popular: true, bundle: true, prices: { UNICO: 0.2411 }, act: 0.1088 },
  { id: 'edp-bt-cartoedp-3', ceme: 'edp', name: 'Cartão EDP Charge (Simples) Clientes energia (20%)', kind: 'FIXED', voltage: 'BT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', green: true, popular: true, bundle: true, prices: { UNICO: 0.2143 }, act: 0.1088 },
  { id: 'edp-mt-cartoedp-3', ceme: 'edp', name: 'Cartão EDP Charge (Simples) Clientes energia (20%)', kind: 'FIXED', voltage: 'MT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', green: true, popular: true, bundle: true, prices: { UNICO: 0.2143 }, act: 0.1088 },
  { id: 'edp-bt-cartoedp-4', ceme: 'edp', name: 'Cartão EDP Charge (Simples) Clientes energia / UVE (30%)', kind: 'FIXED', voltage: 'BT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', green: true, bundle: true, prices: { UNICO: 0.1875 }, act: 0.1088 },
  { id: 'edp-mt-cartoedp-4', ceme: 'edp', name: 'Cartão EDP Charge (Simples) Clientes energia / UVE (30%)', kind: 'FIXED', voltage: 'MT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', green: true, bundle: true, prices: { UNICO: 0.1875 }, act: 0.1088 },
  { id: 'edp-bt-cartoedp-5', ceme: 'edp', name: 'Cartão EDP Charge (Simples) Colaboradores (25%)', kind: 'FIXED', voltage: 'BT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', green: true, bundle: true, prices: { UNICO: 0.2009 }, act: 0.1088 },
  { id: 'edp-mt-cartoedp-5', ceme: 'edp', name: 'Cartão EDP Charge (Simples) Colaboradores (25%)', kind: 'FIXED', voltage: 'MT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', green: true, bundle: true, prices: { UNICO: 0.2009 }, act: 0.1088 },
  { id: 'edp-bt-cartoedp-6', ceme: 'edp', name: 'Cartão EDP Charge Frota (Simples)', kind: 'FIXED', voltage: 'BT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', green: true, bundle: true, prices: { UNICO: 0.2678 }, act: 0.1088, url: 'https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/' },
  { id: 'edp-mt-cartoedp-6', ceme: 'edp', name: 'Cartão EDP Charge Frota (Simples)', kind: 'FIXED', voltage: 'MT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', green: true, bundle: true, prices: { UNICO: 0.2678 }, act: 0.1088, url: 'https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/' },
  { id: 'edp-bt-cartoedp-7', ceme: 'edp', name: 'Cartão EDP Charge Frota (Simples) Clientes Energia', kind: 'FIXED', voltage: 'BT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', green: true, bundle: true, prices: { UNICO: 0.2143 }, act: 0.1088, url: 'https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/' },
  { id: 'edp-mt-cartoedp-7', ceme: 'edp', name: 'Cartão EDP Charge Frota (Simples) Clientes Energia', kind: 'FIXED', voltage: 'MT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', green: true, bundle: true, prices: { UNICO: 0.2143 }, act: 0.1088, url: 'https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/' },
  { id: 'edp-bt-cartoedp-8', ceme: 'edp', name: 'Cartão EDP Charge (Bi-Horário)', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, popular: true, prices: { VAZIO: 0.1927, FORA_VAZIO: 0.2826 }, act: 0.1088 },
  { id: 'edp-mt-cartoedp-8', ceme: 'edp', name: 'Cartão EDP Charge (Bi-Horário)', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, popular: true, prices: { VAZIO: 0.1927, FORA_VAZIO: 0.2826 }, act: 0.1088 },
  { id: 'edp-bt-cartoedp-9', ceme: 'edp', name: 'Cartão EDP Charge (Bi-Horário) Associados UVE (10%)', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.1735, FORA_VAZIO: 0.2544 }, act: 0.1088 },
  { id: 'edp-mt-cartoedp-9', ceme: 'edp', name: 'Cartão EDP Charge (Bi-Horário) Associados UVE (10%)', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.1735, FORA_VAZIO: 0.2544 }, act: 0.1088 },
  { id: 'edp-bt-cartoedp-10', ceme: 'edp', name: 'Cartão EDP Charge (Bi-Horário) Clientes energia (20%)', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.1542, FORA_VAZIO: 0.2261 }, act: 0.1088 },
  { id: 'edp-mt-cartoedp-10', ceme: 'edp', name: 'Cartão EDP Charge (Bi-Horário) Clientes energia (20%)', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.1542, FORA_VAZIO: 0.2261 }, act: 0.1088 },
  { id: 'edp-bt-cartoedp-11', ceme: 'edp', name: 'Cartão EDP Charge (Bi-Horário) Clientes energia / UVE (30%)', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.1349, FORA_VAZIO: 0.1979 }, act: 0.1088 },
  { id: 'edp-mt-cartoedp-11', ceme: 'edp', name: 'Cartão EDP Charge (Bi-Horário) Clientes energia / UVE (30%)', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.1349, FORA_VAZIO: 0.1979 }, act: 0.1088 },
  { id: 'edp-bt-cartoedp-13', ceme: 'edp', name: 'Cartão EDP Charge (Bi-Horário) Frota', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.1927, FORA_VAZIO: 0.2826 }, act: 0.1088, url: 'https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/' },
  { id: 'edp-mt-cartoedp-13', ceme: 'edp', name: 'Cartão EDP Charge (Bi-Horário) Frota', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.1927, FORA_VAZIO: 0.2826 }, act: 0.1088, url: 'https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/' },
  { id: 'edp-bt-cartoedp-14', ceme: 'edp', name: 'Cartão EDP Charge (Bi-Horário) Frota Clientes Energia', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.1542, FORA_VAZIO: 0.2261 }, act: 0.1088, url: 'https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/' },
  { id: 'edp-mt-cartoedp-14', ceme: 'edp', name: 'Cartão EDP Charge (Bi-Horário) Frota Clientes Energia', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.1542, FORA_VAZIO: 0.2261 }, act: 0.1088, url: 'https://www.edp.pt/empresas/servicos/mobilidade-eletrica/cartao-edp-charge-frota/' },
  { id: 'evaz-bt-planomovebas', ceme: 'evaz', name: 'Plano Move Base', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'CARTAO', green: true, prices: { VAZIO: 0.169, FORA_VAZIO: 0.2635 }, act: 0.1088 },
  { id: 'evaz-mt-planomovebas', ceme: 'evaz', name: 'Plano Move Base', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'CARTAO', green: true, prices: { VAZIO: 0.169, FORA_VAZIO: 0.2635 }, act: 0.1088 },
  { id: 'evaz-bt-planomovebas-2', ceme: 'evaz', name: 'Plano Move Base', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'CARTAO', green: true, prices: { VAZIO: 0.169, FORA_VAZIO: 0.2635 }, act: 0.1088 },
  { id: 'evaz-mt-planomovebas-2', ceme: 'evaz', name: 'Plano Move Base', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'CARTAO', green: true, prices: { VAZIO: 0.169, FORA_VAZIO: 0.2635 }, act: 0.1088 },
  { id: 'evaz-bt-planomovehom', ceme: 'evaz', name: 'Plano Move HOME', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'CARTAO', green: true, bundle: true, prices: { VAZIO: 0.1606, FORA_VAZIO: 0.2504 }, act: 0.1088 },
  { id: 'evaz-mt-planomovehom', ceme: 'evaz', name: 'Plano Move HOME', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'CARTAO', green: true, bundle: true, prices: { VAZIO: 0.1606, FORA_VAZIO: 0.2504 }, act: 0.1088 },
  { id: 'evaz-bt-planomovehom-2', ceme: 'evaz', name: 'Plano Move HOME', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'CARTAO', green: true, bundle: true, prices: { VAZIO: 0.1606, FORA_VAZIO: 0.2504 }, act: 0.1088 },
  { id: 'evaz-mt-planomovehom-2', ceme: 'evaz', name: 'Plano Move HOME', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'CARTAO', green: true, bundle: true, prices: { VAZIO: 0.1606, FORA_VAZIO: 0.2504 }, act: 0.1088 },
  { id: 'acp-bt-acpelectricb', ceme: 'acp', name: 'ACP Electric by EVIO - sócio ACP', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, popular: true, bundle: true, prices: { VAZIO: 0.1772, FORA_VAZIO: 0.2698 }, act: 0.15 },
  { id: 'acp-mt-acpelectricb', ceme: 'acp', name: 'ACP Electric by EVIO - sócio ACP', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, popular: true, bundle: true, prices: { VAZIO: 0.1663, FORA_VAZIO: 0.2318 }, act: 0.15 },
  { id: 'acp-bt-acpelectricb-2', ceme: 'acp', name: 'ACP Electric by EVIO - não sócio ACP', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, prices: { VAZIO: 0.1956, FORA_VAZIO: 0.2882 }, act: 0.15 },
  { id: 'acp-mt-acpelectricb-2', ceme: 'acp', name: 'ACP Electric by EVIO - não sócio ACP', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, prices: { VAZIO: 0.1847, FORA_VAZIO: 0.2502 }, act: 0.15 },
  { id: 'enable-bt-tarifasimple', ceme: 'enable', name: 'Tarifa Simples', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', green: true, popular: true, regions: 'CONT,MAD,AZO', prices: { VAZIO: 0.1466, FORA_VAZIO: 0.2392 }, act: 0.1088 },
  { id: 'enable-mt-tarifasimple', ceme: 'enable', name: 'Tarifa Simples', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', green: true, popular: true, regions: 'CONT,MAD,AZO', prices: { VAZIO: 0.1357, FORA_VAZIO: 0.2012 }, act: 0.1088 },
  { id: 'evio-bt-hyundaiblue', ceme: 'evio', name: 'Hyundai Blue', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.1956, FORA_VAZIO: 0.2882 }, act: 0.1572 },
  { id: 'evio-mt-hyundaiblue', ceme: 'evio', name: 'Hyundai Blue', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.1847, FORA_VAZIO: 0.2502 }, act: 0.1572 },
  { id: 'evio-bt-evio', ceme: 'evio', name: 'EVIO', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, popular: true, prices: { VAZIO: 0.1956, FORA_VAZIO: 0.2882 }, act: 0.15 },
  { id: 'evio-mt-evio', ceme: 'evio', name: 'EVIO', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, popular: true, prices: { VAZIO: 0.1847, FORA_VAZIO: 0.2502 }, act: 0.15 },
  { id: 'evio-bt-gochargeby', ceme: 'evio', name: 'Go.Charge by EVIO', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, prices: { VAZIO: 0.1956, FORA_VAZIO: 0.2882 }, act: 0.1572, url: 'https://www.gocharge.pt/app-carregamento-eletrico/' },
  { id: 'evio-mt-gochargeby', ceme: 'evio', name: 'Go.Charge by EVIO', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, prices: { VAZIO: 0.1847, FORA_VAZIO: 0.2502 }, act: 0.1572, url: 'https://www.gocharge.pt/app-carregamento-eletrico/' },
  { id: 'ezu-bt-tarifrioceme', ceme: 'ezu', name: 'Tarifário CEME', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'CARTAO', green: true, prices: { VAZIO: 0.1766, FORA_VAZIO: 0.2692 }, act: 0.1088 },
  { id: 'ezu-mt-tarifrioceme', ceme: 'ezu', name: 'Tarifário CEME', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'CARTAO', green: true, prices: { VAZIO: 0.1657, FORA_VAZIO: 0.2312 }, act: 0.1088 },
  { id: 'galp-bt-galpelectric', ceme: 'galp', name: 'Galp Electric Energia Verde', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, popular: true, prices: { VAZIO: 0.2149, FORA_VAZIO: 0.2895 }, act: 0.1088 },
  { id: 'galp-mt-galpelectric', ceme: 'galp', name: 'Galp Electric Energia Verde', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, popular: true, prices: { VAZIO: 0.2149, FORA_VAZIO: 0.2895 }, act: 0.1088 },
  { id: 'galp-bt-galpelectric-2', ceme: 'galp', name: 'Galp Electric Energia Verde', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', green: true, popular: true, prices: { VAZIO: 0.2149, FORA_VAZIO: 0.2895 }, act: 0.1088 },
  { id: 'galp-mt-galpelectric-2', ceme: 'galp', name: 'Galp Electric Energia Verde', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', green: true, popular: true, prices: { VAZIO: 0.2149, FORA_VAZIO: 0.2895 }, act: 0.1088 },
  { id: 'galp-bt-galpelectric-3', ceme: 'galp', name: 'Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar sem Wallbox (18% desconto)', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, popular: true, bundle: true, prices: { VAZIO: 0.1763, FORA_VAZIO: 0.2374 }, act: 0.1088 },
  { id: 'galp-mt-galpelectric-3', ceme: 'galp', name: 'Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar sem Wallbox (18% desconto)', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, popular: true, bundle: true, prices: { VAZIO: 0.1763, FORA_VAZIO: 0.2374 }, act: 0.1088 },
  { id: 'galp-bt-galpelectric-4', ceme: 'galp', name: 'Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar sem Wallbox (18% desconto)', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', green: true, popular: true, bundle: true, prices: { VAZIO: 0.1763, FORA_VAZIO: 0.2374 }, act: 0.1088 },
  { id: 'galp-mt-galpelectric-4', ceme: 'galp', name: 'Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar sem Wallbox (18% desconto)', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', green: true, popular: true, bundle: true, prices: { VAZIO: 0.1763, FORA_VAZIO: 0.2374 }, act: 0.1088 },
  { id: 'galp-bt-galpelectric-5', ceme: 'galp', name: 'Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar com Wallbox (20% desconto)', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.172, FORA_VAZIO: 0.2316 }, act: 0.1088 },
  { id: 'galp-mt-galpelectric-5', ceme: 'galp', name: 'Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar com Wallbox (20% desconto)', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.172, FORA_VAZIO: 0.2316 }, act: 0.1088 },
  { id: 'galp-bt-galpelectric-6', ceme: 'galp', name: 'Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar com Wallbox (20% desconto)', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.172, FORA_VAZIO: 0.2316 }, act: 0.1088 },
  { id: 'galp-mt-galpelectric-6', ceme: 'galp', name: 'Galp Electric Energia Verde Plano Mobilidade Elétrica & Solar com Wallbox (20% desconto)', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.172, FORA_VAZIO: 0.2316 }, act: 0.1088 },
  { id: 'goldenergy-bt-clientesgold', ceme: 'goldenergy', name: 'Clientes Goldenergy Comercialização', kind: 'FIXED', voltage: 'BT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', green: true, bundle: true, prices: { UNICO: 0.2222 }, act: 0.1088 },
  { id: 'goldenergy-mt-clientesgold', ceme: 'goldenergy', name: 'Clientes Goldenergy Comercialização', kind: 'FIXED', voltage: 'MT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', green: true, bundle: true, prices: { UNICO: 0.2222 }, act: 0.1088 },
  { id: 'goldenergy-bt-noclientes', ceme: 'goldenergy', name: 'Não Clientes Goldenergy Comercialização', kind: 'FIXED', voltage: 'BT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', green: true, prices: { UNICO: 0.2778 }, act: 0.1088 },
  { id: 'goldenergy-mt-noclientes', ceme: 'goldenergy', name: 'Não Clientes Goldenergy Comercialização', kind: 'FIXED', voltage: 'MT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', green: true, prices: { UNICO: 0.2778 }, act: 0.1088 },
  { id: 'hgp-bt-cartoceme', ceme: 'hgp', name: 'Cartão CEME', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'CARTAO', green: true, prices: { VAZIO: 0.2966, FORA_VAZIO: 0.3892 }, act: 0.1088 },
  { id: 'hgp-mt-cartoceme', ceme: 'hgp', name: 'Cartão CEME', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'CARTAO', green: true, prices: { VAZIO: 0.2857, FORA_VAZIO: 0.3512 }, act: 0.1088 },
  { id: 'iberdrola-bt-cartomobilid', ceme: 'iberdrola', name: 'Cartão Mobilidade Elétrica', kind: 'FIXED', voltage: 'BT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'CARTAO', green: true, popular: true, prices: { UNICO: 0.2486 }, act: 0.1088 },
  { id: 'iberdrola-mt-cartomobilid', ceme: 'iberdrola', name: 'Cartão Mobilidade Elétrica', kind: 'FIXED', voltage: 'MT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'CARTAO', green: true, popular: true, prices: { UNICO: 0.2486 }, act: 0.1088 },
  { id: 'iberdrola-bt-clienteeletr', ceme: 'iberdrola', name: 'Cliente Eletricidade Iberdrola', kind: 'FIXED', voltage: 'BT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'CARTAO', green: true, bundle: true, prices: { UNICO: 0.1989 }, act: 0.1088 },
  { id: 'iberdrola-mt-clienteeletr', ceme: 'iberdrola', name: 'Cliente Eletricidade Iberdrola', kind: 'FIXED', voltage: 'MT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'CARTAO', green: true, bundle: true, prices: { UNICO: 0.1989 }, act: 0.1088 },
  { id: 'meo-bt-mobilidadeel-2', ceme: 'meo', name: 'Mobilidade Elétrica com Tarifa Fixa Cliente MEO Energia e tem MEO M5e/M4e', kind: 'FIXED', voltage: 'BT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'CARTAO', green: true, bundle: true, prices: { UNICO: 0.225 }, act: 0.1088 },
  { id: 'meo-mt-mobilidadeel-2', ceme: 'meo', name: 'Mobilidade Elétrica com Tarifa Fixa Cliente MEO Energia e tem MEO M5e/M4e', kind: 'FIXED', voltage: 'MT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'CARTAO', green: true, bundle: true, prices: { UNICO: 0.225 }, act: 0.1088 },
  { id: 'miio-bt-miiobihor', ceme: 'miio', name: 'miio (Bi-Horário Semanal) sem subscrição', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', green: true, popular: true, prices: { VAZIO: 0.2666, FORA_VAZIO: 0.3592 }, act: 0.0 },
  { id: 'miio-mt-miiobihor', ceme: 'miio', name: 'miio (Bi-Horário Semanal) sem subscrição', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', green: true, popular: true, prices: { VAZIO: 0.2557, FORA_VAZIO: 0.3212 }, act: 0.0 },
  { id: 'miio-bt-miioonebi', ceme: 'miio', name: 'miio one (Bi-Horário Semanal) subscrição', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.1966, FORA_VAZIO: 0.2892 }, act: 0.0 },
  { id: 'miio-mt-miioonebi', ceme: 'miio', name: 'miio one (Bi-Horário Semanal) subscrição', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.1857, FORA_VAZIO: 0.2512 }, act: 0.0 },
  { id: 'miio-bt-miiobihor-2', ceme: 'miio', name: 'miio (Bi-Horário Diário) sem subscrição', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, prices: { VAZIO: 0.2666, FORA_VAZIO: 0.3592 }, act: 0.0 },
  { id: 'miio-mt-miiobihor-2', ceme: 'miio', name: 'miio (Bi-Horário Diário) sem subscrição', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, prices: { VAZIO: 0.2557, FORA_VAZIO: 0.3212 }, act: 0.0 },
  { id: 'miio-bt-miioonebi-2', ceme: 'miio', name: 'miio one (Bi-Horário Diário) subscrição', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.1966, FORA_VAZIO: 0.2892 }, act: 0.0 },
  { id: 'miio-mt-miioonebi-2', ceme: 'miio', name: 'miio one (Bi-Horário Diário) subscrição', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, bundle: true, prices: { VAZIO: 0.1857, FORA_VAZIO: 0.2512 }, act: 0.0 },
  { id: 'prio-bt-prioelectric', ceme: 'prio', name: 'Prio Electric (EUR/kWh)', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, popular: true, prices: { VAZIO: 0.1765, FORA_VAZIO: 0.2591 }, act: 0.1088 },
  { id: 'prio-mt-prioelectric', ceme: 'prio', name: 'Prio Electric (EUR/kWh)', kind: 'FIXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, popular: true, prices: { VAZIO: 0.1656, FORA_VAZIO: 0.2211 }, act: 0.1088 },
  { id: 'repsol-bt-pessoassingu', ceme: 'repsol', name: 'Pessoas Singulares', kind: 'FIXED', voltage: 'BT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'CARTAO', prices: { UNICO: 0.2868 }, act: 0.1088 },
  { id: 'repsol-mt-pessoassingu', ceme: 'repsol', name: 'Pessoas Singulares', kind: 'FIXED', voltage: 'MT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'CARTAO', prices: { UNICO: 0.2868 }, act: 0.1088 },
  { id: 'ynerluz-bt', ceme: 'ynerluz', name: 'Mobilidade Elétrica', kind: 'INDEXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, prices: null, act: 0.1572 },
  { id: 'ynerluz-mt', ceme: 'ynerluz', name: 'Mobilidade Elétrica', kind: 'INDEXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'AMBOS', green: true, prices: null, act: 0.1572 },
  { id: 'luzigas-ceme-bt', ceme: 'luzigas', name: 'Tarifário Indexado Cliente CEME', kind: 'INDEXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'CARTAO', popular: true, prices: null, act: 0.1088 },
  { id: 'luzigas-ceme-mt', ceme: 'luzigas', name: 'Tarifário Indexado Cliente CEME', kind: 'INDEXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'CARTAO', popular: true, prices: null, act: 0.1088 },
  { id: 'luzigas-casa-bt', ceme: 'luzigas', name: 'Tarifário Indexado Cliente Casa e CEME', kind: 'INDEXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'CARTAO', popular: true, bundle: true, prices: null, act: 0.1088 },
  { id: 'luzigas-casa-mt', ceme: 'luzigas', name: 'Tarifário Indexado Cliente Casa e CEME', kind: 'INDEXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'CARTAO', popular: true, bundle: true, prices: null, act: 0.1088 },
  { id: 'luzigas-k0010-bt', ceme: 'luzigas', name: 'Tarifário Indexado Cliente CEME (K=0,010)', kind: 'INDEXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', bundle: true, prices: null, act: 0.1088 },
  { id: 'luzigas-k0010-mt', ceme: 'luzigas', name: 'Tarifário Indexado Cliente CEME (K=0,010)', kind: 'INDEXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', access: 'AMBOS', bundle: true, prices: null, act: 0.1088 },
  // Campanha de preço fixo na app, só para novas adesões, de 29/10 a 28/11.
  { id: 'luzigas-promo-ceme-bt', ceme: 'luzigas', name: 'Tarifário Promocional Cliente CEME', kind: 'FIXED', voltage: 'BT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', prices: { UNICO: 0.3199 }, act: 0.1088, newCustomers: true, from: '2026-10-29', to: '2026-11-28', url: 'https://www.luzigas.pt/app-mobilidade-eletrica/' },
  { id: 'luzigas-promo-ceme-mt', ceme: 'luzigas', name: 'Tarifário Promocional Cliente CEME', kind: 'FIXED', voltage: 'MT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', prices: { UNICO: 0.3199 }, act: 0.1088, newCustomers: true, from: '2026-10-29', to: '2026-11-28', url: 'https://www.luzigas.pt/app-mobilidade-eletrica/' },
  { id: 'luzigas-promo-casa-bt', ceme: 'luzigas', name: 'Tarifário Promocional Cliente Casa e CEME', kind: 'FIXED', voltage: 'BT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', bundle: true, prices: { UNICO: 0.2599 }, act: 0.1088, newCustomers: true, from: '2026-10-29', to: '2026-11-28', url: 'https://www.luzigas.pt/app-mobilidade-eletrica/' },
  { id: 'luzigas-promo-casa-mt', ceme: 'luzigas', name: 'Tarifário Promocional Cliente Casa e CEME', kind: 'FIXED', voltage: 'MT', schedule: 'SIMPLES', cycle: 'SIMPLES', access: 'AMBOS', bundle: true, prices: { UNICO: 0.2599 }, act: 0.1088, newCustomers: true, from: '2026-10-29', to: '2026-11-28', url: 'https://www.luzigas.pt/app-mobilidade-eletrica/' },
  { id: 'meo-dinamica-bt', ceme: 'meo', name: 'Mobilidade Elétrica com Tarifa Dinâmica Exclusivo Clientes MEO *e* MEO Energia', kind: 'INDEXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'CARTAO', green: true, bundle: true, prices: null, act: 0.1088 },
  { id: 'meo-dinamica-mt', ceme: 'meo', name: 'Mobilidade Elétrica com Tarifa Dinâmica Exclusivo Clientes MEO *e* MEO Energia', kind: 'INDEXED', voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'DIARIO', access: 'CARTAO', green: true, bundle: true, prices: null, act: 0.1088 },
];

// Notas por tarifário. São CÓDIGOS, não texto: o frontend traduz cada um
// para PT ou EN (vê NOTE_KEY em frontend/index.html).
//   AC_DC_FLAT: o preço é para postos AC; nos postos DC o CEME tem outro
//   preço, com a tarifa do posto incluída, que o simulador não calcula.
export const NOTES = {
  'atlante-bt-myatlanteac': 'AC_DC_FLAT',
  'atlante-mt-myatlanteac': 'AC_DC_FLAT',
  'atlante-bt-myatlantebus': 'AC_DC_FLAT',
  'atlante-mt-myatlantebus': 'AC_DC_FLAT',
};

// A data em que os preços do seed foram verificados. Usa-se como
// `valid_from` de todas as versões e a interface mostra-a como "preços
// verificados em". Não é a data em que cada tarifário começou: essa não se
// sabe sem perguntar a cada CEME.
export const PRICES_VERIFIED_ON = '2026-10-15';

// Parâmetros dos indexados, por tarifário (vê engine/indexed.js):
//   k:       margem do CEME, €/kWh
//   cgs:     custos de gestão do sistema, €/kWh
//   loss:    perdas fixas a usar só se não houver perfil por quarto de hora
//   formula: 'ynerluz' para a fórmula alternativa; sem isto, 'standard'.
export const VERSIONS = {
  "ynerluz-bt": { k: 0.02, cgs: 0.025, loss: 0.1531275537, formula: "ynerluz" },
  "ynerluz-mt": { k: 0.02, cgs: 0.025, loss: 0.07127022935, formula: "ynerluz" },
  "luzigas-ceme-bt": { k: 0.05, cgs: 0.0183 },
  "luzigas-ceme-mt": { k: 0.05, cgs: 0.0183 },
  "luzigas-casa-bt": { k: 0.005, cgs: 0.0183 },
  "luzigas-casa-mt": { k: 0.005, cgs: 0.0183 },
  "luzigas-k0010-bt": { k: 0.01, cgs: 0.0183 },
  "luzigas-k0010-mt": { k: 0.01, cgs: 0.0183 },
  "meo-dinamica-bt": { k: 0.065, cgs: 0.0 },
  "meo-dinamica-mt": { k: 0.065, cgs: 0.0 },
};

// Campanhas que já acabaram: { id do tarifário: último dia, inclusive }.
// O seed põe esse dia em `valid_to`, `campaign = 1` e `status = 'EXPIRED'`,
// e o simulador deixa de mostrar o tarifário no dia seguinte. Como o
// UPDATE corre depois do upsert, voltar a correr o seed nunca reabre uma
// campanha fechada.
export const CAMPAIGN_END = {
};

// O número de cada tarifário na folha de cálculo original (coluna B da aba
// CEME). Quem integrou com a folha (ex.: plan2charge) usa estes números, por
// isso a API devolve-os em `legacy_id`. Não é único: uma linha "BT/MT" da
// folha dá dois tarifários aqui, e a tensão desempata. Fica congelado: um
// tarifário novo não ganha número.
export const LEGACY_IDS = {
  'atlante-bt-myatlanteac': 92,
  'atlante-mt-myatlanteac': 93,
  'atlante-bt-myatlantebus': 117,
  'atlante-mt-myatlantebus': 118,
  'moeve-bt-gow': 3,
  'moeve-mt-gow': 96,
  'charge2go-bt-ecogreen': 4,
  'charge2go-bt-ecogreen-2': 5,
  'charge2go-mt-ecogreen': 6,
  'charge2go-mt-ecogreen-2': 7,
  'viaverde-bt-viaverdeelec': 60,
  'viaverde-bt-viaverdeelec-2': 61,
  'viaverde-mt-viaverdeelec': 8,
  'viaverde-mt-viaverdeelec-2': 9,
  'edp-bt-cartoedp': 10,
  'edp-mt-cartoedp': 10,
  'edp-bt-cartoedp-2': 11,
  'edp-mt-cartoedp-2': 11,
  'edp-bt-cartoedp-3': 12,
  'edp-mt-cartoedp-3': 12,
  'edp-bt-cartoedp-4': 13,
  'edp-mt-cartoedp-4': 13,
  'edp-bt-cartoedp-5': 111,
  'edp-mt-cartoedp-5': 111,
  'edp-bt-cartoedp-6': 85,
  'edp-mt-cartoedp-6': 85,
  'edp-bt-cartoedp-7': 83,
  'edp-mt-cartoedp-7': 83,
  'edp-bt-cartoedp-8': 67,
  'edp-mt-cartoedp-8': 67,
  'edp-bt-cartoedp-9': 68,
  'edp-mt-cartoedp-9': 68,
  'edp-bt-cartoedp-10': 69,
  'edp-mt-cartoedp-10': 69,
  'edp-bt-cartoedp-11': 70,
  'edp-mt-cartoedp-11': 70,
  'edp-bt-cartoedp-13': 87,
  'edp-mt-cartoedp-13': 87,
  'edp-bt-cartoedp-14': 88,
  'edp-mt-cartoedp-14': 88,
  'evaz-bt-planomovebas': 18,
  'evaz-mt-planomovebas': 113,
  'evaz-bt-planomovebas-2': 19,
  'evaz-mt-planomovebas-2': 114,
  'evaz-bt-planomovehom': 20,
  'evaz-mt-planomovehom': 115,
  'evaz-bt-planomovehom-2': 21,
  'evaz-mt-planomovehom-2': 116,
  'acp-bt-acpelectricb': 22,
  'acp-mt-acpelectricb': 23,
  'acp-bt-acpelectricb-2': 24,
  'acp-mt-acpelectricb-2': 25,
  'enable-bt-tarifasimple': 121,
  'enable-mt-tarifasimple': 121,
  'evio-bt-hyundaiblue': 26,
  'evio-mt-hyundaiblue': 27,
  'evio-bt-evio': 28,
  'evio-mt-evio': 29,
  'evio-bt-gochargeby': 30,
  'evio-mt-gochargeby': 74,
  'ezu-bt-tarifrioceme': 94,
  'ezu-mt-tarifrioceme': 95,
  'galp-bt-galpelectric': 33,
  'galp-mt-galpelectric': 33,
  'galp-bt-galpelectric-2': 34,
  'galp-mt-galpelectric-2': 34,
  'galp-bt-galpelectric-3': 35,
  'galp-mt-galpelectric-3': 35,
  'galp-bt-galpelectric-4': 36,
  'galp-mt-galpelectric-4': 36,
  'galp-bt-galpelectric-5': 78,
  'galp-mt-galpelectric-5': 78,
  'galp-bt-galpelectric-6': 79,
  'galp-mt-galpelectric-6': 79,
  'goldenergy-bt-clientesgold': 41,
  'goldenergy-mt-clientesgold': 41,
  'goldenergy-bt-noclientes': 75,
  'goldenergy-mt-noclientes': 75,
  'hgp-bt-cartoceme': 42,
  'hgp-mt-cartoceme': 43,
  'iberdrola-bt-cartomobilid': 44,
  'iberdrola-mt-cartomobilid': 44,
  'iberdrola-bt-clienteeletr': 45,
  'iberdrola-mt-clienteeletr': 45,
  'meo-bt-mobilidadeel-2': 82,
  'meo-mt-mobilidadeel-2': 82,
  'miio-bt-miiobihor': 99,
  'miio-mt-miiobihor': 102,
  'miio-bt-miioonebi': 101,
  'miio-mt-miioonebi': 104,
  'miio-bt-miiobihor-2': 110,
  'miio-mt-miiobihor-2': 105,
  'miio-bt-miioonebi-2': 108,
  'miio-mt-miioonebi-2': 109,
  'prio-bt-prioelectric': 49,
  'prio-mt-prioelectric': 50,
  'repsol-bt-pessoassingu': 51,
  'repsol-mt-pessoassingu': 51,
  'ynerluz-bt': 122,
  'ynerluz-mt': 123,
  'luzigas-ceme-bt': 52,
  'luzigas-ceme-mt': 53,
  'luzigas-casa-bt': 54,
  'luzigas-casa-mt': 55,
  'luzigas-k0010-bt': 90,
  'luzigas-k0010-mt': 91,
  'meo-dinamica-bt': 97,
  'meo-dinamica-mt': 98,
};

// Tarifários e CEME que saíram. O seed só faz upsert e a role do runtime não
// tem DELETE, por isso quem os apaga da BD é o migrate-cli (com a role dona,
// vê removeRetired em db/migrate.js). Ficam aqui para uma BD antiga perder
// o que já não está no seed.
export const RETIRED_TARIFFS = [
  'bluecharge-bt-cartobluecha', 'bluecharge-mt-cartobluecha',
  'bluecharge-bt-cartobluecha-2', 'bluecharge-mt-cartobluecha-2',
  'edp-bt-cartoedp-12', 'edp-mt-cartoedp-12',
  'evpower-bt-cartoevpower', 'evpower-mt-cartoevpower',
  'ezu-bt-abenergia', 'ezu-mt-abenergia',
  'factorenergia-bt-vecard', 'factorenergia-mt-vecard',
  'factorenergia-bt-vecard-2', 'factorenergia-mt-vecard-2',
  'meo-bt-mobilidadeel', 'meo-mt-mobilidadeel',
  'mobismart-bt-cartode', 'mobismart-mt-cartode',
  'mobismart-bt-cartode-2', 'mobismart-mt-cartode-2',
];
export const RETIRED_CEMES = ['bluecharge', 'evpower', 'factorenergia', 'mobismart'];

// Promoções de um CEME, quase sempre numa rede de postos, uma por objecto
// (vê a tabela `promo` em db/schema.sql). Não mexem no preço do tarifário: o
// /v1/simulate devolve-as ao lado de cada tarifário a que se aplicam, e quem
// sabe em que posto carregas escolhe as da rede certa.
//   id        identificador único (ceme-rede-aaaa-mm do início)
//   ceme      id do CEME (vê CEMES)
//   name      o nome da promoção, como o CEME a anuncia
//   tariffs   ids dos tarifários abrangidos; sem isto, todos os do CEME
//   network   o nome da rede de postos, igual ao que o ohmigo usa em
//             offers/networks.json (Powerdot, EDP…). Sem isto, vale em
//             qualquer posto MOBI.E
//   target    ENERGIA: `eurKwh` a menos no preço final do CEME (energia +
//             TAR), antes de IEC, EGME e IVA. O simulador cota-o.
//             OPC: `pct` a menos na taxa do operador do posto. O simulador
//             não cota OPC, só devolve a percentagem.
//             FINAL: o carregamento todo a `eurKwh` por kWh, com CEME, OPC,
//             taxas e IVA lá dentro (o preço "tudo incluído" que o CEME
//             anuncia numa rede). O simulador cota-o: kWh × eurKwh.
//             KWH_GRATIS: os primeiros `freeKwh` de cada mês civil não pagam
//             energia nem TAR (o IEC, a EGME e o IVA pagam-se na mesma).
//             Quanto já se gastou desse mês vem no pedido (`monthKwh`, vê
//             docs/04): o simulador não guarda nada sobre ninguém.
//   from, to  o primeiro e o último dia, inclusive
//   newCustomers  true se é só para quem adere durante a promoção: um
//             cliente que já o era não a tem, por isso nunca entra no
//             preço por omissão
//   maxHours  quanto tempo dura o desconto depois da adesão, se tiver limite
//   regions   onde vale (CONT,MAD,AZO). Por omissão CONT
//   url       onde a promoção está publicada; checked: o dia em que a lemos
// Uma promoção que acabou não se apaga daqui: o `to` já a tira do simulador
// no dia seguinte, e o seed só faz upserts.
export const PROMOS = [
  {
    // Só nos tarifários promocionais: 0,3199 − 0,12 = 0,1999 e 0,2599 − 0,12
    // = 0,1399, os dois preços que a página anuncia, como os tarifários, só
    // para novas adesões. Quem a aplica é o ohmigo, que sabe se o posto é da
    // Powerdot. A página diz 7 dias depois da activação.
    id: 'luzigas-powerdot-2026-10', ceme: 'luzigas', name: 'LUZiGÁS × Powerdot: −0,12 €/kWh no tarifário promocional',
    tariffs: ['luzigas-promo-ceme-bt', 'luzigas-promo-ceme-mt', 'luzigas-promo-casa-bt', 'luzigas-promo-casa-mt'],
    network: 'Powerdot', target: 'ENERGIA', eurKwh: 0.12, from: '2026-10-29', to: '2026-11-28',
    newCustomers: true, maxHours: 168,
    url: 'https://www.luzigas.pt/app-mobilidade-eletrica/', checked: '2026-10-30',
  },
  {
    // O regulamento só fala de 2 de Março a 31 de Maio; a página da
    // promoção, mais recente, diz até 31 de Dezembro.
    id: 'moeve-cepsa-2026-03', ceme: 'moeve',
    name: 'Moeve Preço Único: até 0,50 €/kWh tudo incluído nos postos Moeve/Cepsa (a partir do 2.º kWh; o gow devolve 0,02 €/kWh em saldo)',
    network: 'Cepsa/Moeve', target: 'FINAL', eurKwh: 0.50, from: '2026-03-02', to: '2026-12-31',
    url: 'https://pt.moeveglobal.com/pt/promocoes/mobilidade-eletrica-preco-fixo', checked: '2026-10-29',
  },
  {
    // Os quatro tarifários "UVE" da EDP são os dos sócios. A página diz que
    // não exige contrato de energia em casa.
    id: 'edp-uve-2026-09', ceme: 'edp', name: 'EDP × UVE: 0,47 €/kWh tudo incluído na rede pública EDP, para sócios UVE',
    tariffs: ['edp-bt-cartoedp-2', 'edp-mt-cartoedp-2', 'edp-bt-cartoedp-4', 'edp-mt-cartoedp-4',
      'edp-bt-cartoedp-9', 'edp-mt-cartoedp-9', 'edp-bt-cartoedp-11', 'edp-mt-cartoedp-11'],
    network: 'EDP', target: 'FINAL', eurKwh: 0.47, from: '2026-09-01', to: '2026-12-31',
    url: 'https://www.uve.pt/page/protocolo-edp-uve-preco-fixo/', checked: '2026-10-29',
  },
  {
    // Sem data de início nem de fim publicadas ("oferta de lançamento"): o
    // `to` é a data em que tens de a voltar a ver. Nenhuma fonte diz o que
    // os 7 kWh cobrem; assume-se só a componente CEME (energia + TAR).
    id: 'goldenergy-7kwh', ceme: 'goldenergy', name: 'GoldEnergy: 7 kWh por mês oferecidos a clientes de electricidade',
    tariffs: ['goldenergy-bt-clientesgold', 'goldenergy-mt-clientesgold'],
    target: 'KWH_GRATIS', freeKwh: 7, from: '2026-10-29', to: '2026-12-31',
    url: 'https://goldenergy.pt/mobilidade-eletrica/', checked: '2026-10-29',
  },
  {
    id: 'miio-powerdot-2026-02', ceme: 'miio', name: 'miio one: −45 % na tarifa do operador nos postos Powerdot',
    tariffs: ['miio-bt-miioonebi', 'miio-mt-miioonebi', 'miio-bt-miioonebi-2', 'miio-mt-miioonebi-2'],
    network: 'Powerdot', target: 'OPC', pct: 45, from: '2026-02-03', to: '2026-12-31',
    url: 'https://www.miio.com/pt/miio-one', checked: '2026-10-29',
  },
];
