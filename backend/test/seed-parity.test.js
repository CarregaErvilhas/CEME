// Os dois seeds (SQLite e Postgres) têm de ter os mesmos dados.
//
// Os ficheiros andam em paralelo por mão — toda a alteração de preço vai aos
// dois. Um comentário a pedir isso apodrece; este teste não: compara os
// dados linha a linha, para nenhuma correcção ficar só num dos lados.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const lite = await import('../src/db/seed.js');
const pg = await import('../src/db/seed.postgres.js');

describe('seed.js ≡ seed.postgres.js', () => {
  for (const name of ['CEMES', 'TARIFFS', 'NOTES', 'VERSIONS', 'CAMPAIGN_END', 'SHEET_SNAPSHOT']) {
    it(`${name} iguais nos dois dialetos`, () => {
      assert.deepEqual(pg[name], lite[name], `${name} divergiu entre seed.js e seed.postgres.js`);
    });
  }
});
