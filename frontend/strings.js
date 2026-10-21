/* Dicionário das duas interfaces do CEME.
 *
 * As duas páginas (assistente e simulador completo) partilham este ficheiro
 * para os textos não divergirem: o mesmo conceito tem uma chave só, e a
 * tradução faz-se uma vez. Cada HTML pede o seu namespace com `CEME_STR(ns)`,
 * que junta `common` + as chaves da página — os nomes das páginas nunca se
 * cruzam, e um teste garante que nenhuma chave se repete entre `common` e um
 * namespace.
 *
 * Regras: PT e EN têm exactamente as mesmas chaves e os mesmos placeholders
 * (`{n}`, `{v}`, …); nada de valores duplicados em dois sítios — se duas
 * páginas dizem o mesmo, a chave vive em `common`.
 */
(function (g) {
  // Nome, IVA e fuso de cada região. O `vat` é o número; `iva`/`fuso` são o
  // texto já pronto para a UI.
  const regions = {
    CONT: { pt: { nome: 'Portugal Continental', curto: 'Continente', vat: 23, iva: 'IVA 23%', fuso: 'hora de Lisboa' },
            en: { nome: 'Mainland Portugal', curto: 'Mainland', vat: 23, iva: 'VAT 23%', fuso: 'Lisbon time' } },
    MAD:  { pt: { nome: 'Madeira', curto: 'Madeira', vat: 22, iva: 'IVA 22%', fuso: 'hora do Funchal' },
            en: { nome: 'Madeira', curto: 'Madeira', vat: 22, iva: 'VAT 22%', fuso: 'Funchal time' } },
    AZO:  { pt: { nome: 'Açores', curto: 'Açores', vat: 16, iva: 'IVA 16%', fuso: 'hora dos Açores (UTC−1)' },
            en: { nome: 'Azores', curto: 'Azores', vat: 16, iva: 'VAT 16%', fuso: 'Azores time (UTC−1)' } },
  };

  // Vocabulário partilhado: filtros e etiquetas dos tarifários, que as duas
  // interfaces mostram com o mesmo sentido e o mesmo texto.
  const common = {
    pt: {
      fPopular: '★ populares', tagPopular: 'popular',
      fGreen: '⚡ verde', tagGreen: 'verde',
      fNoBundle: 'sem condições', tagBundle: 'com condições',
      retry: 'Tentar outra vez', now: 'Agora', kwhIn: 'Energia a carregar',
    },
    en: {
      fPopular: '★ popular', tagPopular: 'popular',
      fGreen: '⚡ green', tagGreen: 'green',
      fNoBundle: 'no conditions', tagBundle: 'conditional',
      retry: 'Try again', now: 'Now', kwhIn: 'Energy to charge',
    },
  };

  g.CEME_I18N = {
    regions,
    common,
    // Textos do simulador completo (frontend/index.html).
    simulador: {
      pt: {
        docTitle: 'Comparador CEME @ O Carro Elétrico',
        logoA: 'Comparador CEME', logoB: '@ O Carro Elétrico',
        navHome: 'Simular', navCmp: 'Indexado vs fixo', navSimple: 'Assistente',
        // hero
        h1a: 'Quanto custa ', h1b: 'carregar agora?',
        scopeHint: '⚠️ Simula só a <b>parcela de energia</b> (CEME + IEC + IVA + EGME). <u>Não inclui a tarifa de utilização do posto (OPC)</u>.',
        nowPrefix: 'agora:', avg: 'média:', nTariffs: 'tarifários',
        // âmbito
        scopeTitle: 'Isto é só uma parte do custo de carregamento',
        scopeHint2: 'O custo de um carregamento na rede Mobi.E é composto por várias parcelas. Este simulador calcula <b>apenas a parcela de energia</b>.',
        rowCeme: 'Tarifário do CEME (venda de electricidade)',
        rowTar: 'TAR (Tarifas de Acesso às Redes)',
        rowIec: 'IEC (Imposto Especial sobre o Consumo)',
        rowVat: 'IVA ({rate} nesta região)',
        rowEgme: 'EGME — taxa de ativação da CEME',
        rowOpc: '<b>Tarifa OPC — utilização do posto</b>',
        rowOpcEgme: 'EGME cobrada pelo OPC diretamente',
        rowOther: 'Outros serviços (ex. apps, seguros)',
        yes: 'sim', no: 'não',
        yesTar: 'incluída no €/kWh', yesEgme: 'embutida no tarifário',
        scopeWarn: '<b>O valor apresentado é o mínimo da parcela de energia.</b> A fatura final será maior, por causa da <b>tarifa de utilização do posto (OPC)</b> — cada operador define a sua e pode ser €/kWh, €/minuto ou €/sessão. O valor está sempre publicado no próprio posto, e varia de posto para posto dentro da mesma rede.',
        linkCost: 'Estrutura oficial do custo ↗', linkFaq: 'FAQ da Mobi.E ↗',
        // energia
        modeKwh: 'kWh direto', modeBat: 'bateria %',
        ramalTip: 'Tensão da instalação (afecta a TAR). BT = baixa tensão, MT = média tensão.',
        kwh: 'kWh', search: 'Pesquisar', searchPh: 'ex. luzigas, ACP, EDP…',
        capacity: 'Capacidade (kWh)', min: 'Mínimo', max: 'Máximo',
        chargingFrom: 'Carrega de {a}% a {b}% → {c} kWh',
        region: 'Região',
        fFavOn: '★ favoritos', fFavOff: '☆ favoritos', fFavMgr: '★ gerir favoritos ({n})',
        when: 'Data/hora do carregamento', whenPh: 'aaaa/mm/dd hh:mm',
        tFixed: 'Hora fixa seleccionada — a usar o instante indicado.',
        tSkew: '⚠️ relógio do browser desviado >5 min do servidor — a usar hora do servidor.',
        tBrowser: 'A usar hora do browser.', tMode: ' · modo “agora”.',
        ranking: 'Ranking', noRes: 'Sem resultados — ajusta os filtros.',
        // cartões
        simple: 'Simples', biHourly: 'Bi-horária · {c}', cycDaily: 'ciclo diário',
        cycWeekly: 'ciclo semanal', cycSimple: 'tarifa simples',
        idxOmie: 'Indexado OMIE', fixedPrice: 'Preço fixo', green: '⚡ energia verde',
        acOnly: 'só em AC',
        noteACDC: 'AC = carregamento em corrente alternada. Este é o preço da energia nos postos AC. Nos postos DC a Atlante pratica um preço promocional flat, com o CEME e o OPC já incluídos — por isso não sai aqui.',
        needsHome: 'preço com condições', bundleTip: 'Preço condicionado a ter outra relação com a CEME — contrato de electricidade doméstica, subscrição, associação, ou colaborador. Vem da coluna «Bundles» do simulador original: não significa só «cliente casa».', soldIn: 'comercializado em: {r}',
        estTip: 'preço estimado, não retirado do tarifário publicado pelo CEME',
        cheapest: 'MAIS BARATO', rightNowIn: 'neste momento em', inclVat: 'com IVA',
        saveFav: 'guardar nos favoritos',
        breakdown: 'Composição do preço', period: 'Período', noVat: '€/kWh s/ IVA*',
        kwhVat: '{k} kWh s/ IVA', activation: 'Taxa de ativação', formula: 'Fórmula',
        formulaVal: '(OMIE {o} + K {k} + CGS {c}) × (1 + perdas {l}) + TAR',
        vatIncl: '{v}% incluído no total',
        verified: 'Preços verificados em',
        verifiedTip: 'Data em que estes dados foram capturados a partir do simulador da ERSE. Não é a data de início do contrato: a folha de origem não tem essa informação, e cada comercializador publica-a onde lhe apetece. Nos tarifários indexados o preço mostrado é recalculado agora com o OMIE do momento — esta data refere-se aos componentes (K, CGS, TAR).',
        breakdownNote: '* fixos: preço final já com TAR incluída · indexados: calculado agora.',
        confirmSrc: 'Confirmar na página do CEME ↗',
        // períodos
        pVazio: 'vazio', pFora: 'fora de vazio', pUnico: 'preço único',
        // favoritos
        fmTitle: '★ Gerir favoritos', fmPh: 'pesquisar tarifário ou CEME…',
        fmPop: 'só populares',
        fmFoot: 'Clica num tarifário para marcar/desmarcar como favorito. Guardado neste browser.',
        fmNoRes: 'Sem resultados.',
        kIndexed: 'Indexado', kFixed: 'Fixo',
        // comparador
        cmpH1a: 'Indexado ', cmpH1b: 'vs fixo',
        cmpSub: 'Histórico de 60 dias e valor actual · <b>{r}</b> <small>({v})</small>',
        loading: 'A carregar tarifários…', lIndexed: 'Indexado', lFixed: 'Fixo',
        omieRef: 'OMIE de referência (€/kWh)',
        last60: 'Últimos 60 dias (€/kWh s/ IVA)', calcHist: 'A calcular histórico…',
        whenCharge: 'Quando carregar: quarto-horário de hoje (€/kWh s/ IVA)',
        calcQ: 'A calcular quartos-horários…',
        chartDays: ' · {n} dias', legendIdxPeak: 'indexado fora de vazio', legendIdxOff: 'indexado vazio',
        legendFixed: 'fixo', legendWins: 'dias em que o indexado ganha',
        omipEst: 'estimativa OMIP', byTime: 'por hora', cheapestQ: 'mais baratos',
        eightCheap: '8 quartos mais baratos:', thTime: 'Hora', thOmie: 'OMIE €/MWh',
        thIdx: 'Indexado €/kWh', thFix: 'Fixo €/kWh', thWin: 'Melhor',
        winIdx: 'indexado', winFix: 'fixo', winEq: 'empate',
        vsFixed: 'Indexado mais barato em {w} dos {n} quartos',
        vsFixedNone: 'Em nenhum quarto o indexado bate o fixo',
        vsFixedNoData: 'Sem tarifário fixo escolhido para comparar',
        qCompareNote: 'Comparação do componente de energia (s/ IVA), mesmo período, mesmo instante. A tarifa de ativação não entra: é um valor único e não se repete por quarto de hora.',
        qUnavailable: 'Quartos-horários indisponíveis.',
        bootFail: 'Não consegui carregar a lista de tarifários.',
        bootFailWhy: 'O servidor pode estar a acordar (o primeiro pedido com cache fria pode demorar dezenas de segundos) ou a ligação falhou.',
        egmeStale: 'Activ. > EGME 2026',
        egmeStaleTip: 'A taxa de activação publicada por este CEME ({act} €/carregamento) está acima do valor legal em vigor 2026 ({legal} €/carregamento, Regul. ERSE 7/2026). É normal — vários CEMEs ainda não actualizaram o valor de 2025 (0,157 €) ou publicam valores próprios. O simulador mostra o publicado; a actualização é do CEME, não do cálculo.',

        kIdx: 'indexado', kFix: 'fixo', diffNow: 'diferença agora',
        fixedWins: 'fixo ganha', idxWins: 'indexado ganha',
        winsTxt: 'Em <b>{w}/{d}</b> dias o indexado teria ganho em fora de vazio. Com OMIE abaixo de <b>{be}€/kWh</b>, o indexado ganha hoje. <br>Série: {src}{cache}.',
        histUnavail: 'Histórico indisponível. O valor actual acima continua válido.',
        // avisos do servidor
        warnOmieCont: 'ref. OMIE continental — ilustrativo',
        // rodapé
        footScope: '<b>Âmbito:</b> o simulador calcula só a parcela de energia (tarifário do CEME + TAR + IEC + IVA + EGME). <b>Não inclui a tarifa de utilização do posto (OPC)</b>, que cada operador define e publica no próprio posto — por isso o valor final na fatura será maior.',
        footRest: 'Valores com IVA da região de carregamento. <code>~</code> marca um preço estimado. Séries OMIE via dados.tiagofelicia.pt (CC BY 4.0); produção usa omie.es. Favoritos ficam neste browser — sem conta, sem tracking.',
        cache: ' (cache)',
      },
      en: {
        docTitle: 'EV Tariff Comparison @ O Carro Elétrico',
        logoA: 'EV Tariff Comparison', logoB: '@ O Carro Elétrico',
        navHome: 'Simulation', navCmp: 'Indexed to OMIE vs fixed', navSimple: 'Assistant',
        // hero
        h1a: 'How much does it cost ', h1b: 'to charge right now?',
        scopeHint: '⚠️ Only the <b>energy component</b> is calculated here (CEME + IEC + VAT + EGME). <u>The charging point operator tariff is not included</u>.',
        nowPrefix: 'now:', avg: 'average:', nTariffs: 'tariffs',
        // âmbito
        scopeTitle: 'This is only part of what a charging session costs',
        scopeHint2: 'A charging session on the Mobi.E network is billed in several parts. This tool only works out the <b>energy component</b>.',
        rowCeme: 'CEME tariff (the electricity itself)',
        rowTar: 'TAR (network access tariffs)',
        rowIec: 'IEC (special consumption tax)',
        rowVat: 'VAT ({rate} in this region)',
        rowEgme: 'CEME activation fee (EGME network fee)',
        rowOpc: '<b>CPO tariff — use of the charging point</b>',
        rowOpcEgme: 'EGME fee charged by the CPO on top',
        rowOther: 'Other services (apps, insurance, …)',
        yes: 'yes', no: 'not included',
        yesTar: 'built into the €/kWh', yesEgme: 'built into the tariff',
        scopeWarn: '<b>What you see here is the cheapest the energy component can be.</b> Your final bill will be higher, because it also includes the <b>CPO tariff for the charging point</b> — each operator sets its own, charged as €/kWh, €/minute or €/session. Every operator publishes that tariff at the charging point, and it differs from one point to the next, even within the same network.',
        linkCost: 'Official cost breakdown ↗', linkFaq: 'Mobi.E FAQ ↗',
        // energia
        modeKwh: 'kWh', modeBat: 'battery %',
        ramalTip: 'Supply voltage of your installation (changes the network access tariff). BT = low voltage, MT = medium voltage.',
        kwh: 'kWh', search: 'Search', searchPh: 'e.g. Luzigas, ACP, EDP…',
        capacity: 'Battery capacity (kWh)', min: 'From', max: 'To',
        chargingFrom: 'Charging from {a}% to {b}% → {c} kWh',
        region: 'Region',
        fFavOn: '★ saved', fFavOff: '☆ saved', fFavMgr: '★ saved tariffs ({n})',
        when: 'When you charge', whenPh: 'yyyy/mm/dd hh:mm',
        tFixed: 'A specific time is set — pricing for that moment.',
        tSkew: '⚠️ your device clock is more than 5 min off the server — using server time.',
        tBrowser: 'Using your device clock.', tMode: ' · “now” mode.',
        ranking: 'Ranking', noRes: 'No results — try relaxing the filters.',
        // cartões
        simple: 'Simple rate', biHourly: 'Two periods · {c}', cycDaily: 'same every day',
        cycWeekly: 'day and night', cycSimple: 'single rate',
        idxOmie: 'Tracks the OMIE price', fixedPrice: 'Fixed price', green: '⚡ renewable energy',
        acOnly: 'AC only',
        noteACDC: 'AC = alternating-current charging. This is the energy price at AC points. At DC points the retailer applies a flat promotional price with the retailer and the charging point operator already included — which is why it is not shown here.',
        needsHome: 'conditional price', bundleTip: 'The price is conditional on having another relationship with the retailer — a home electricity contract, a subscription, a membership, or employee status. It comes from the original spreadsheet’s “Bundles” column: it does not just mean “home customer”.', soldIn: 'only sold in: {r}',
        estTip: 'estimated — not from the retailer’s published tariff',
        cheapest: 'CHEAPEST', rightNowIn: 'right now in', inclVat: 'incl. VAT',
        saveFav: 'save this tariff',
        breakdown: 'Breakdown of the price', period: 'Period', noVat: '€/kWh excl. VAT*',
        kwhVat: '{k} kWh incl. VAT', activation: 'Activation fee', formula: 'Formula',
        formulaVal: '(OMIE {o} + K {k} + CGS {c}) × (1 + losses {l}) + TAR',
        vatIncl: '{v}% — already included above',
        verified: 'Prices checked on',
        verifiedTip: 'When this data was captured from the ERSE simulator. It is not the date the contract started: the source spreadsheet carries no such information, and each retailer publishes it where it sees fit. For indexed tariffs the price shown is recalculated now with the current OMIE — this date refers to the components (K, CGS, TAR).',
        breakdownNote: '* fixed tariffs already include TAR · indexed tariffs are priced live.',
        confirmSrc: 'Check on the retailer’s own page ↗',
        // períodos
        pVazio: 'off-peak', pFora: 'peak', pUnico: 'single rate',
        // favoritos
        fmTitle: '★ Saved tariffs', fmPh: 'search a tariff or retailer…',
        fmPop: 'popular only',
        fmFoot: 'Click a tariff to save it or remove it. Your list stays in this browser.',
        fmNoRes: 'Nothing matches.',
        kIndexed: 'Indexed', kFixed: 'Fixed',
        // comparador
        cmpH1a: 'Indexed to OMIE ', cmpH1b: 'vs fixed tariff',
        cmpSub: 'Last 60 days and today’s price · <b>{r}</b> <small>({v})</small>',
        loading: 'Loading tariffs…', lIndexed: 'Indexed tariff', lFixed: 'Fixed tariff',
        omieRef: 'OMIE reference price (€/kWh)',
        last60: 'Last 60 days (€/kWh excl. VAT)', calcHist: 'Building the 60-day history…',
        whenCharge: 'Best times to charge: today’s quarter-hourly slots (€/kWh excl. VAT)',
        calcQ: 'Working out the quarter-hourly slots…',
        chartDays: ' · {n} days', legendIdxPeak: 'indexed tariff, peak', legendIdxOff: 'indexed tariff, off-peak',
        legendFixed: 'fixed tariff', legendWins: 'days the indexed tariff was cheaper',
        omipEst: 'OMIP estimate', byTime: 'by time', cheapestQ: 'cheapest first',
        eightCheap: 'The 8 cheapest quarter-hour slots:', thTime: 'Time', thOmie: 'OMIE €/MWh',
        thIdx: 'Indexed €/kWh', thFix: 'Fixed €/kWh', thWin: 'Better',
        winIdx: 'indexed', winFix: 'fixed', winEq: 'tie',
        vsFixed: 'Indexed is cheaper in {w} of the {n} quarter-hour slots',
        vsFixedNone: 'The indexed tariff is not cheaper in any slot',
        vsFixedNoData: 'No fixed tariff selected to compare against',
        qCompareNote: 'Comparison of the energy component (excl. VAT), same period, same instant. The activation charge is excluded: it is a one-off and does not repeat every quarter of an hour.',
        qUnavailable: 'Quarter-hourly slots are not available right now.',
        bootFail: 'Could not load the tariff list.',
        bootFailWhy: 'The server may still be starting up (the first request with a cold cache can take tens of seconds), or the connection failed.',
        egmeStale: 'Activ. > EGME 2026',
        egmeStaleTip: 'The activation charge this CEME publishes ({act} €/session) is above the legal rate in force for 2026 ({legal} €/session, ERSE Regulation 7/2026). That is normal — several CEMEs have not yet updated the 2025 value (€0.157) or publish their own. The simulator shows what is published; updating it is on the CEME, not the calculation.',

        kIdx: 'indexed tariff', kFix: 'fixed tariff', diffNow: 'difference right now',
        fixedWins: 'the fixed tariff is cheaper', idxWins: 'the indexed tariff is cheaper',
        winsTxt: 'On <b>{w} of the last {d} days</b> the indexed tariff would have worked out cheaper during peak hours. It stays cheaper today whenever OMIE falls below <b>{be}€/kWh</b>. <br>Series: {src}{cache}.',
        histUnavail: 'The 60-day history is not available. The price shown above is still correct.',
        warnOmieCont: 'uses the mainland OMIE price — indicative only',
        // rodapé
        footScope: '<b>What this covers:</b> only the energy component — the CEME tariff plus TAR, IEC, VAT and the activation fee. <b>It does not include the CPO tariff for the charging point</b>, which every operator sets and publishes at the point itself, so your final bill will be higher.',
        footRest: 'Prices include the VAT of the region where you charge. <code>~</code> marks an estimated price. OMIE price data from dados.tiagofelicia.pt (CC BY 4.0). Your saved tariffs stay in this browser — no account, no tracking.',
        cache: ' (cached)',
      },
    },
    // Textos do assistente passo-a-passo (frontend/assistente.html).
    assistente: {
      pt: {
        docTitle: 'CEME — o tarifário mais barato',
        h1: 'Qual tarifário fica mais barato no seu carregamento?',
        lede: 'Três perguntas para comparar mais de 50 tarifários Mobi.E em Portugal.',
        start: 'Começar',
        community: 'Projeto comunitário, sem fins lucrativos.', fullSim: 'Abrir o simulador completo',
        back: 'Voltar', next: 'Continuar', see: 'Ver resultados', theme: 'Tema claro / escuro',
        whereH: 'Onde vai carregar?', whereL: 'O IVA muda de região para região.',
        CONT: 'Continente', MAD: 'Madeira', AZO: 'Açores',
        howH: 'Quanto vai carregar?', howL: 'Arraste as pegas ou escreva os valores.',
        from: 'Carga atual', to: 'Carregar até', have: 'Já tem', add: 'Vai carregar',
        cap: 'Capacidade da bateria', other: 'Outra', capHint: 'Não sabe? 60 kWh é um valor comum.',
        whenH: 'Quando vai carregar?', whenL: 'O preço é calculado para a hora a que começa a carregar. Muitos tarifários são mais baratos à noite.',
        tonight: 'Esta noite', tomorrow: 'Amanhã de manhã', pick: 'Escolher', pickSub: 'data e hora',
        startsAt: 'Começa às', today: 'Hoje', tmrw: 'Amanhã', from_: 'a partir das',
        calc: 'A calcular…', cheapest: 'Mais barato para este carregamento',
        perKwh: '{p} por kWh, IVA incluído', below: '<b>{v}</b> abaixo da média dos tarifários',
        scope: 'Inclui só a energia. O posto cobra à parte a sua própria tarifa (OPC).', scopeLink: 'Saber mais',
        others: 'Outros tarifários',
        est: 'estimado',
        showAll: 'Mostrar todos ({n})', none: 'Nenhum tarifário com estes filtros.',
        restart: 'Começar de novo',
        err: 'Não foi possível calcular. Verifique a ligação à internet.',
      },
      en: {
        docTitle: 'CEME — the cheapest tariff',
        h1: 'Which tariff is cheapest for your charge?',
        lede: 'Three questions to compare over 50 Mobi.E tariffs in Portugal.',
        start: 'Start',
        community: 'A non-profit community project.', fullSim: 'Open the full simulator',
        back: 'Back', next: 'Continue', see: 'See results', theme: 'Light / dark theme',
        whereH: 'Where are you charging?', whereL: 'VAT differs from region to region.',
        CONT: 'Mainland', MAD: 'Madeira', AZO: 'Azores',
        howH: 'How much will you charge?', howL: 'Drag the handles or type the values.',
        from: 'Current charge', to: 'Charge to', have: 'Already in', add: 'Charging',
        cap: 'Battery capacity', other: 'Other', capHint: 'Not sure? 60 kWh is a common size.',
        whenH: 'When are you charging?', whenL: 'The price is calculated for the time you start charging. Many tariffs are cheaper at night.',
        tonight: 'Tonight', tomorrow: 'Tomorrow morning', pick: 'Pick', pickSub: 'date and time',
        startsAt: 'Starts at', today: 'Today', tmrw: 'Tomorrow', from_: 'from',
        calc: 'Calculating…', cheapest: 'Cheapest for this charge',
        perKwh: '{p} per kWh, VAT included', below: '<b>{v}</b> below the average tariff',
        scope: 'Energy only. The charging point adds its own fee (OPC) on top.', scopeLink: 'Learn more',
        others: 'Other tariffs',
        est: 'estimated',
        showAll: 'Show all ({n})', none: 'No tariffs match these filters.',
        restart: 'Start over',
        err: 'Could not calculate. Check your internet connection.',
      },
    },
  };

  // Junta `common` ao namespace pedido e devolve { pt, en } plano, que é a
  // forma que as duas páginas já consomem (`STR[lang][chave]`).
  g.CEME_STR = function (ns) {
    const M = g.CEME_I18N;
    const page = M[ns] || {};
    const out = {};
    for (const l of ['pt', 'en']) out[l] = Object.assign({}, M.common[l], page[l]);
    return out;
  };
}(window));
