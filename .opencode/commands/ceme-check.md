---
description: Verificar se as tarifas CEME publicadas online divergem do seed/DB (ceme-v2)
---

Verificações de tarifas CEME do projecto `ceme-v2/`.

**Antes de avançar, lê o cookbook em `ceme-v2/.memories/ceme-tarifas-verificacao.md`**
(caminho relativo a tmp/opencode; se o session já corre dentro de `ceme-v2/`, é
`.memories/ceme-tarifas-verificacao.md`) — tem o método por CEME (curl/imagens/PDF/
browser), valores de referência (TAR/EGME), gotchas de extracção, o fluxo de update
(backup → seed.js → seed.postgres.js → DB → tests) e o registo da última verificação
feita.

Âmbito para esta corrida: $ARGUMENTS

Regras:
- Se $ARGUMENTS estiver vazio, percorre todos os CEMEs. Se for um cure_id (ex.: `galp`),
  verifica só esse. Se for "update", salta a verificação e pergunta-me primeiro os
  valores a aplicar antes de tocar no seed/DB.
- Actualizações de valores **só** depois de eu autorizar — com a tabela de drift
  proposta, valor antigo → novo, e a fonte (página/PDF + data de vigência).
- URLs mudos de apontar à página certa do tarifário vão sempre bem (seed.js +
  seed.postgres.js + DB).
- No fim: `npm test` em `ceme-v2/backend` e re-congelar âncoras de testes com o motor
  (não à mão) se houver valores alterados; relatório em tabela com ✓/⚠️/❌ e backup do
  ceme.db antes de qualquer UPDATE.
