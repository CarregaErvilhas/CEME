# Third-party notices — CEME

O nosso código, documentação, motor de cálculo e seed são
`PolyForm-Noncommercial-1.0.0` (vê `LICENSE`). Tudo o que está abaixo mantém
as **suas próprias** licenças e termos e **não** está coberto pela PolyForm.

## Dados e fontes

| Recurso | Origem | Licença / termos | O que fazemos |
|---|---|---|---|
| Lista de CEME da ERSE, transcrita no `backend/src/db/seed.js` | Simulador de Mobilidade Elétrica da ERSE — `https://www.erse.pt/simuladores/mobilidade-eletrica/lista-de` | **CC BY 4.0** na folha de origem, de autoria de terceiro. | Atribuição em `README.md`. Nada da folha é redistribuído: o seed é uma transcrição de valores publicados, com o nome de cada comercializador e o URL da sua página de tarifas. **A folha em si não entra no repositório.** |
| Séries OMIE: quartos-horários, histórico anual e futuros | **`https://www.omie.es`** (fonte oficial: o dump acumulado público `INT_PBC_EV_H_ACUM.TXT`), via `backend/src/omie/omiees.js` | Informação pública de entidade pública (OMIE — Operador do Mercado Ibérico de Energía). | Fonte **primária** do preço. O ficheiro é público e não precisa de credenciais; é pedido de forma condicional (ETag/Last-Modified) para não se repetir o download quando não mudou. Nada é versionado: os dados vão para a BD (`omie_spot`), não para o repositório. |
| Séries OMIE: a mesma informação republicada em CSV (com a classificação do período horário e as estimativas OMIP) | `https://dados.tiagofelicia.pt` (CSV), via `backend/src/omie/tf.js` | **CC BY 4.0**, conforme indicado na folha de origem. | Fonte **secundária**: traz a classificação BD/BS (as regras da ERSE) e as estimativas dos dias que a OMIE ainda não publicou; nos buracos do omie.es, o preço. Atribuição obrigatória, e é o que a coluna `source` da API devolve (`omie.es (OMIE/MIBEL) + dados.tiagofelicia.pt (CC BY 4.0)`). Nada é versionado: os CSV ficam em `backend/data/` (cache descartável), que está no `.gitignore`. |
| Diretivas de TAR | **ERSE** | Informação pública de entidade pública. | Transcritas à mão em `backend/src/server.js` (`TAR_2026`), para as três regiões (`docs/07`). |
| Perfis de perdas E-REDES | `https://www.e-redes.pt/pt-pt/perfis-de-perdas-2026` | Publicação da E-REDES, sem licença de reutilização explícita. | Convertidos por `scripts/etl-perdas.py` em `backend/src/engine/losses-<ano>.json` (só os factores por quarto de hora). |
| Valores de IEC, EGME e IVA | **ERSE** / DGEG / Código do IVA | Informação pública. | Idem. |
| Texto do aviso de âmbito sobre a composição da factura | `https://mobie.pt/custo-do-carregamento` e `https://mobie.pt/pt/carregarveiculo/faq` | **© MOBI.E, todos os direitos reservados.** Sem licença explícita de reutilização. | **Só o link**, nunca o texto copiado. Linkificado no `README.md` e no rodapé do frontend. |
| Nomes, marcas e URLs dos comercializadores | Cada comercializador, através da sua página pública de tarifas | Propriedade de cada operador. | Referidos apenas para identificar o que se está a comparar, com link para a fonte. Se um operador pedir a remoção do seu link, remove-se. |

## Dependências de runtime

**Uma:** `pg` (driver PostgreSQL, em `backend/package.json` + `package-lock.json`).
O resto do backend usa só módulos do Node (`node:http`, `node:sqlite`,
`node:test`, `node:crypto`) e o frontend é HTML/JS sem build. A `pg` é
usada apenas quando `DATABASE_URL` está definida (produção); em dev/teste
corre SQLite e a dependência não é exercitada.

## O que NÃO está aqui, e porquê

| Coisa | Motivo |
|---|---|
| A folha de cálculo de origem e os dumps TSV (`backend/seed/`) | Obra de terceiro com licença própria (CC BY 4.0). Pô-la aqui publicaria trabalho alheio sem a atribuição que a licença exige. Fica fora do repositório. |
| `backend/data/` (SQLite local + cache dos CSV do TF) | Gerado. `seed()` reconstrói a base do zero e a cache volta a ser descarregada. Está no `.gitignore`. |

## Regra de conduta para novos dados

Qualquer fonte nova que entre no projecto tem de:

1. constar desta tabela, com origem e licença;
2. ter a atribuição visível no sítio (rodapé ou ao lado do dado);
3. continuar sob a sua própria licença, nunca re-licenciada sob a PolyForm;
4. se a licença for ambígua ou estiver ausente, entrar como **referência
   factual com link**, não como cópia — e sair se o titular pedir.