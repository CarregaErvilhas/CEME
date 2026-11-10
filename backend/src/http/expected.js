// Erros esperados: falhas do pedido ou dos dados (ex.: "sem TAR ...") cuja
// mensagem foi escrita para quem chama e pode seguir na resposta. Qualquer
// outro erro é falha do servidor: fica no log e o cliente só recebe uma
// mensagem fixa, para não vazar nomes de máquinas, SQL ou detalhes internos.
import { fail } from './respond.js';

export class ExpectedError extends Error {}

export const GENERIC_MESSAGE = 'erro interno';

// Responde a um erro apanhado num handler. Esperado: 400 com a mensagem.
// Inesperado: log completo e `status`/`code` com mensagem fixa.
export function failFromError(res, e, headers, { where, status = 500, code = 'internal_error', message = GENERIC_MESSAGE } = {}) {
  if (e instanceof ExpectedError) return fail(res, 400, 'quote_failed', e.message, headers);
  console.error(`[ceme-v2] ${where}:`, e);
  return fail(res, status, code, message, headers);
}
