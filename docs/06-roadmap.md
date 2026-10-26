# 06 — Roadmap

Só o que está **por fazer**. O que já existe está descrito nos outros
documentos. Quando acabares um item, tira-o daqui.

## Regras e dados regulados

- **Validar os horários dos Açores:** o ciclo diário e o fim da noite de
  sábado no Inverno vêm do PDF da ERSE; falta confirmar com uma fatura da
  EDA ([07](07-ilhas.md)).
- **Feriados em MT no ciclo semanal:** a Diretiva 3/2026 (n.º 10) trata os
  feriados como domingos para MT no ciclo semanal. Falta confirmar se os
  ciclos dos CEME seguem a mesma regra; hoje um feriado conta como o dia da
  semana em que calha.
- **Horários de 2027:** a Diretiva 3/2026 muda os períodos do Continente
  por fases, de Abril a Dezembro de 2027 (por exemplo, o bi-horário diário
  passa para 08:30–22:30 e o sábado semanal para um bloco único). Os
  períodos em `engine/regions.js` não têm datas: é preciso versioná-los
  antes de a primeira fase entrar em vigor.
- **TAR de 2027:** a tabela de TAR da mobilidade da ERSE aplica-se no regime
  transitório do DL 93/2025, até 31-12-2026. É preciso saber o que a
  substitui antes de Janeiro. A de um ano novo entra como uma entrada nova
  em `TAR` (`backend/src/db/tar.js`).
- **Perdas na BD:** a tabela `loss_profile` existe mas não se usa; os
  perfis de perdas vêm de `engine/losses-<ano>.json`.

## Motor

- **Indexado simples:** o motor só calcula indexados bi-horários. Um
  indexado de preço único precisa de uma regra para a TAR (que é
  bi-horária); até lá, `quoteOne` põe-no de quarentena. Não há nenhum no
  seed.

## OMIE

- **Comparar omie.es e TF:** medir e mostrar as diferenças entre as duas
  fontes (hoje, quando o omie.es tem o preço, o do TF simplesmente não se
  usa; [03](03-omie-ingestao.md)).

## Testes e infra

- **Testes contra um PostgreSQL real:** hoje os testes correm em SQLite e
  alguns caminhos (o seed e a TAR gravados no Postgres, o `to_regclass` em
  `migrate.js`) só correm em produção ([08](08-sqlite-postgres.md)).
- **Previews por PR:** os scripts `scripts/preview-*.sh` têm os comandos
  comentados; o procedimento está em [preview-envs](preview-envs.md).

## Produto

- Frontend com Vite + React + Tailwind.
- Portal para cada CEME actualizar os seus tarifários, e administração.
- Sugestões de correcção da comunidade (`suggestion`), com moderação.
- Emissão e gestão de API keys (hoje há uma só, pela variável de ambiente;
  [04](04-api-auth.md)).
- Os endpoints planeados estão em [04](04-api-auth.md#planos).
