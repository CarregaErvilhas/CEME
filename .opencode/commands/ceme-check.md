---
description: Verificar se as tarifas CEME publicadas online divergem do seed/DB (ceme-v2)
---

Verificar as tarifas CEME deste repositório.

**Antes de avançar, lê o guia em `.memories/ceme-tarifas-verificacao.md`**
(relativo à raiz do repo): tem o método por CEME (curl/imagens/PDF/browser),
onde estão os valores de referência (TAR/EGME), os cuidados na extracção e o
fluxo de actualização (backup → seed-data.js → BD → testes).
A última verificação está no histórico do git do `backend/src/db/seed-data.js`.

Âmbito para esta corrida: $ARGUMENTS

Regras:
- Se $ARGUMENTS estiver vazio, percorre todos os CEMEs. Se for um ceme_id (ex.: `galp`),
  verifica só esse. Se for "update", salta a verificação e pergunta-me primeiro os
  valores a aplicar antes de tocar no seed/DB.
- Actualizações de valores **só** depois de eu autorizar — com a tabela de drift
  proposta, valor antigo → novo, e a fonte (página/PDF + data de vigência).
- Corrigir URLs para apontarem à página certa do tarifário pode fazer-se sem
  pedir (seed-data.js + BD).
- No fim: `npm test` em `backend/` e re-congelar âncoras de testes com o motor
  (não à mão) se houver valores alterados; relatório em tabela com ✓/⚠️/❌ e backup do
  ceme.db antes de qualquer UPDATE.
