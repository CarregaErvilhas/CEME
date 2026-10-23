# 06 — Roadmap

Só o que está **por fazer** (e as decisões de *não* fazer). O que já existe
descreve-se nos outros documentos, não aqui — um roadmap com coisas feitas
lá dentro é um roadmap em que ninguém confia.

## Aberto

- **Períodos:** validar o diário dos Açores e o fecho de sábado de inverno
  contra uma factura EDA (docs/07); regra MT de feriados no ciclo semanal
  (Diretiva 3/2026 n.º 10).
- **Reforma de períodos 2027** (Diretiva 3/2026, faseada Abr–Dez 2027): os
  períodos de `regions.js` não têm dimensão de data — é preciso versioná-los
  antes de a primeira fase entrar em vigor.
- **TAR 2027:** a tabela de TAR da mobilidade da ERSE aplica-se no regime
  transitório do DL 93/2025, até 31-12-2026. Saber o que a substitui antes
  de Janeiro (`TAR_2026` em `server.js`).
- **Perdas E-REDES** por DSO e por quarto de hora (hoje: `LOSS_PLACEHOLDER`
  por tensão, de proveniência incerta — nota em docs/02). A tabela
  `loss_profile` existe e não é usada.
- **Testes contra um PostgreSQL real** (hoje só SQLite; docs/08).
- **Previews por PR:** os scripts (`scripts/preview-*.sh`) são esqueletos,
  com os comandos comentados; o runbook está em `docs/preview-envs.md`.
- **Validação cruzada omie.es vs TF:** medir e expor as divergências (hoje o
  preço do TF é simplesmente descartado quando o omie.es tem o instante;
  docs/03).
- **Upgrade do frontend** para Vite+React+Tailwind; portal CEME; admin;
  emissão/gestão de API keys (hoje: uma chave, pela env — docs/04).

## Decidido não fazer (por agora)

- **Cron de ingestão do OMIE.** A actualização é a pedido, em cada leitura do
  OMIE (docs/03), e chega para o tráfego actual. Revê-se se o tráfego um
  dia o justificar.
- **Cache gerida (Valkey).** Existiu e foi desligada por não ter uso. Volta
  se aparecer um caso de uso.
