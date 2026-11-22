// IndexNow (https://www.indexnow.org): avisa o Bing, e os outros motores que
// partilham os avisos entre si, de que URLs voltar a ler. A Google não entra:
// lê o sitemap.xml. Corre uma vez a cada arranque do processo em produção
// (INDEXNOW=on no zerops.yml), ou seja, depois de cada deploy.
//
// A chave não é segredo: é servida em /<chave>.txt para o motor confirmar que
// quem envia controla o domínio. Os outros sites do grupo usam a mesma.
export const INDEXNOW_KEY = '5162276ff8f52857dee877725610e84e';
const ENDPOINT = 'https://api.indexnow.org/indexnow';

// Um pedido por domínio, porque o IndexNow só aceita URLs do domínio do
// pedido. Uma falha fica no log e não pára nada: o sitemap continua lá.
export async function indexNowSubmit(sites, { fetchImpl = fetch, log = console } = {}) {
  for (const { origin, urls } of sites) {
    const host = new URL(origin).host;
    try {
      const res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host, key: INDEXNOW_KEY, keyLocation: `${origin}/${INDEXNOW_KEY}.txt`, urlList: urls }),
        signal: AbortSignal.timeout(30_000),
      });
      log.log(`[indexnow] ${host}: HTTP ${res.status}, ${urls.length} URLs`);
    } catch (e) {
      log.warn(`[indexnow] ${host}: ${e.message}`);
    }
  }
}
