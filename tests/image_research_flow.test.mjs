import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { execFileSync } from 'node:child_process';

const visionSource = fs.readFileSync(new URL('../api/vision_node.mjs', import.meta.url), 'utf8');
const smartSource = fs.readFileSync(new URL('../smart.js', import.meta.url), 'utf8');
const researchSource = fs.readFileSync(new URL('../research.js', import.meta.url), 'utf8');
const indexSource = fs.readFileSync(new URL('../api/index.py', import.meta.url), 'utf8');

function internals() {
  let source = visionSource
    .replace(/^import .*;\s*$/gm, '')
    .replace('export default async function handler', 'async function handler');
  source += '\nglobalThis.__flow = { normalizeClues, buildSearchQueries, chooseMatch };';
  const context = {
    crypto, isIP, lookup, AbortController,
    getVercelOidcToken: async () => '',
    process: { env: {} }, Buffer, URL, TextEncoder, TextDecoder,
    fetch: async () => { throw new Error('network disabled'); },
    console, setTimeout, clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'vision_node.mjs' });
  return context.__flow;
}
const flow = internals();

const candidate = (overrides={}) => ({
  url:'https://fabricante.example/item', domain:'fabricante.example', title:'Peça Rinnai', name:'Peça Rinnai',
  source_type:'manufacturer', brand:'Rinnai', manufacturer:'Rinnai', model:'M10', code:'ABC123', part_number:'ABC123',
  ean:'7891234567890', description:'Peça técnica', image_url:'', specifications:{}, evidence:[], ...overrides
});

test('TESTE 1 — foto com código inicia pistas e pesquisa', () => {
  const q = flow.buildSearchQueries(flow.normalizeClues({brand:'Rinnai', code:'ABC123'}));
  assert.ok(q.some(x => x.includes('ABC123')));
  assert.match(smartSource, /mode:'clues'/);
  assert.match(smartSource, /mode:'web'/);
});

test('TESTE 2 — EAN exato recebe prioridade', () => {
  const clues = flow.normalizeClues({ean:'7891234567890', brand:'Rinnai'});
  assert.equal(flow.buildSearchQueries(clues)[0], '"7891234567890"');
  assert.equal(flow.chooseMatch([candidate()], clues).match_level, 'forte');
});

test('TESTE 3 — sem código usa pesquisa progressiva por marca/modelo/texto', () => {
  const q = flow.buildSearchQueries(flow.normalizeClues({brand:'Rinnai', model:'M10', name_hint:'válvula', visible_text:['3/4']}));
  assert.ok(q.length >= 2);
  assert.ok(q.some(x => x.includes('M10')));
});

test('TESTE 4 — web geral e Mercado Livre entram no mesmo matching', () => {
  assert.match(visionSource, /mergeCandidates\(body\?\.web_candidates \|\| \[\], body\?\.ml_candidates \|\| \[\]\)/);
  assert.match(smartSource, /\/api\/marketplace\/search-reference/);
  assert.match(indexSource, /\/sites\/\{SITE_ID\}\/search/);
});

test('TESTE 5 — referência do Mercado Livre preserva categoria e atributos', () => {
  assert.match(indexSource, /"category_id": item\.get\("category_id"\)/);
  assert.match(indexSource, /"attributes": ml_attribute_id_map\(attrs\)/);
  assert.match(researchSource, /const categoryId = txt\(mlRef\?\.category_id\)/);
  assert.match(researchSource, /const attributes = mlRef\?\.attributes/);
  assert.match(visionSource, /marketplace_reference/);
});

test('TESTE 6 — candidato parecido com código divergente é rejeitado', () => {
  const clues = flow.normalizeClues({brand:'Rinnai', code:'ABC123', model:'M10'});
  const wrong = candidate({code:'ZZZ999', part_number:'ZZZ999'});
  const result = flow.chooseMatch([wrong], clues);
  assert.equal(result.status, 'PRODUTO_NAO_CONFIRMADO');
});

test('TESTE 7 — produto local existente não é duplicado', () => {
  assert.match(researchSource, /findDuplicate/);
  assert.match(researchSource, /compact\(body\.gtin \|\| research\?\.gtin\)/);
  assert.match(researchSource, /existing_product_id/);
});

test('TESTE 8 — ausência de match confiável vira pendência', () => {
  const clues = flow.normalizeClues({name_hint:'peça metálica', visual_features:['metálica']});
  const result = flow.chooseMatch([candidate({brand:'',model:'',code:'',part_number:'',ean:'',source_type:'marketplace'})], clues);
  assert.equal(result.status, 'PRODUTO_NAO_CONFIRMADO');
  assert.equal(result.selected, null);
});

test('TESTE 9 — web search possui timeout, retry e erro recuperável', () => {
  assert.match(visionSource, /WEB_TIMEOUT_MS/);
  assert.match(visionSource, /MAX_GATEWAY_ATTEMPTS/);
  assert.match(smartSource, /AbortController/);
  assert.match(smartSource, /Tentar novamente/);
});

test('TESTE 10 — Mercado Livre sem resultado não interrompe web geral', () => {
  assert.match(smartSource, /catch \(mlError\)/);
  assert.match(smartSource, /state\.ml_result = \{ candidates:\[\], warnings:/);
  assert.match(smartSource, /web_candidates:state\.web_result\?\.candidates \|\| \[\]/);
});

test('TESTE 11 — fonte externa indisponível tenta próxima fonte', () => {
  assert.match(visionSource, /for \(const c of candidates\)/);
  assert.match(visionSource, /safeFetchPage\(c\.url\)/);
  assert.match(visionSource, /catch \{\}/);
});

test('TESTE 12 — preço e estoque externos nunca substituem ANV', () => {
  assert.match(researchSource, /external_price/);
  assert.match(researchSource, /external_stock/);
  assert.match(researchSource, /delete body\[key\]/);
  assert.doesNotMatch(indexSource.slice(indexSource.indexOf('def ml_reference_candidate'), indexSource.indexOf('@app.post("/api/marketplace/search-reference")')), /"price"|"available_quantity"/);
});

test('TESTE 13 — refresh preserva ou retoma pesquisa', () => {
  assert.match(smartSource, /anv-image-pipeline-v3/);
  assert.match(smartSource, /runPipeline\(saved\.image_data_url/);
  assert.match(researchSource, /anv-image-research-v2/);
  assert.match(researchSource, /loadResearchState/);
});

test('TESTE 14 — fluxo não usa mais timer artificial em Extraindo informações', () => {
  assert.doesNotMatch(researchSource, /\[14500, 'Extraindo informações'/);
  assert.match(smartSource, /setProgress\('Extraindo informações'/);
  assert.match(smartSource, /timeout:48_000/);
  assert.match(visionSource, /mode === 'extract'/);
});


test('CI — sintaxe JS/Python dos arquivos afetados', () => {
  for (const file of ['smart.js','research.js','api/vision_node.mjs','api/anv_ops.mjs']) execFileSync(process.execPath, ['--check', file], { stdio:'pipe' });
  execFileSync('python3', ['-c', "import ast,pathlib; [ast.parse(pathlib.Path(p).read_text()) for p in ['api/index.py','api/page.py']]"], { stdio:'pipe' });
});
