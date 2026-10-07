import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const visionPath = new URL('../api/vision_node.mjs', import.meta.url);
const researchPath = new URL('../research.js', import.meta.url);
const visionSource = fs.readFileSync(visionPath, 'utf8');
const researchSource = fs.readFileSync(researchPath, 'utf8');

function loadVisionInternals() {
  let source = visionSource
    .replace(/^import .*;\s*$/gm, '')
    .replace('export default async function handler', 'async function handler');
  source += '\nglobalThis.__anvTest = { normalizeClues, buildSearchQueries, scoreCandidate, sameIdentity, chooseMatch, crossCheckFacts };';
  const context = {
    crypto, isIP, lookup,
    getVercelOidcToken: async () => '',
    process: { env: {} }, Buffer, URL, TextEncoder, TextDecoder,
    fetch: async () => { throw new Error('network disabled in unit test'); },
    console, setTimeout, clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'vision_node.mjs' });
  return context.__anvTest;
}

const vision = loadVisionInternals();

function candidate(overrides = {}) {
  return {
    url: 'https://fabricante.example/produto',
    domain: 'fabricante.example',
    title: 'Produto técnico',
    name: 'Produto técnico',
    source_type: 'manufacturer',
    manufacturer: 'Rinnai',
    brand: 'Rinnai',
    model: 'M10',
    code: 'ABC123',
    part_number: 'ABC123',
    ean: '',
    description: 'Produto técnico',
    image_url: '',
    specifications: {},
    evidence: [],
    ...overrides
  };
}

test('cenário 1: marca + código exato confirma produto forte', () => {
  const clues = vision.normalizeClues({ brand: 'Rinnai', code: 'ABC123', visible_text: ['ABC123'] });
  const result = vision.chooseMatch([candidate()], clues);
  assert.equal(result.status, 'CONFIRMADO');
  assert.equal(result.match_level, 'forte');
  assert.match(result.selected.evidence.join(' '), /Código\/part number exato/);
});

test('cenário 2: EAN legível tem prioridade e confirma correspondência exata', () => {
  const clues = vision.normalizeClues({ ean: '7891234567890', brand: 'Rinnai' });
  const result = vision.chooseMatch([candidate({ ean: '7891234567890' })], clues);
  assert.equal(result.status, 'CONFIRMADO');
  assert.equal(result.match_level, 'forte');
  assert.match(result.selected.evidence.join(' '), /EAN exato/);
  assert.equal(vision.buildSearchQueries(clues)[0], '"7891234567890"');
});

test('cenário 3: versão visualmente parecida com código divergente não é aceita', () => {
  const clues = vision.normalizeClues({ brand: 'Rinnai', code: 'ABC123', model: 'M10', name_hint: 'Produto técnico' });
  const wrong = candidate({ code: 'ZZZ999', part_number: 'ZZZ999', title: 'Produto técnico', model: 'M10' });
  const result = vision.chooseMatch([wrong], clues);
  assert.equal(result.status, 'PRODUTO_NAO_CONFIRMADO');
  assert.match(result.candidates[0].conflicts.join(' '), /Código divergente/);
});

test('cenário 4: deduplicação do catálogo usa id, GTIN, códigos e marca + modelo', () => {
  assert.match(researchSource, /research\?\.existing_product_id/);
  assert.match(researchSource, /compact\(body\.gtin \|\| research\?\.gtin\)/);
  assert.match(researchSource, /\[body\.code, body\.sku, research\?\.code, research\?\.sku, research\?\.part_number\]/);
  assert.match(researchSource, /norm\(p\.brand\) === brand && norm\(p\.model\) === model/);
});

test('cenário 5: resultado sem evidência suficiente vira pendência real', () => {
  const clues = vision.normalizeClues({ name_hint: 'Peça parecida', visual_features: ['metálica'] });
  const result = vision.chooseMatch([candidate({ source_type: 'marketplace', brand: '', model: '', code: '', part_number: '', title: 'Peça parecida' })], clues);
  assert.equal(result.status, 'PRODUTO_NAO_CONFIRMADO');
  assert.equal(result.selected, null);
});

test('cenário 6: backend possui fallback de fonte acessível', () => {
  assert.match(visionSource, /async function findUsableSource/);
  assert.match(visionSource, /for \(const candidate of pool\)/);
  assert.match(visionSource, /safeFetchPage\(candidate\.url\)/);
});

test('cenário 7: preço e estoque externos não entram no produto técnico', () => {
  assert.match(researchSource, /external_price/);
  assert.match(researchSource, /external_stock/);
  assert.match(researchSource, /for \(const key of \['cost_price','sale_price','minimum_price','stock','minimum_stock','price','qty','external_price','external_stock'\]\) delete body\[key\]/);
});

test('cenário 8: fluxo confirmado persiste pesquisa, foto e inicia preflight sem publicar', () => {
  assert.match(researchSource, /await persistResearch\(productId, research, true\)/);
  assert.match(researchSource, /await runPreflight\(productId\)/);
  assert.doesNotMatch(researchSource, /\/api\/integrations\/mercado-livre\/connect/);
  assert.doesNotMatch(researchSource, /\/api\/marketplace\/publish/);
});

test('match provável exige validação cruzada em domínio diferente', () => {
  const clues = vision.normalizeClues({ brand: 'Rinnai', model: 'M10' });
  const a = candidate({ url: 'https://a.example/m10', domain: 'a.example', source_type: 'technical_reseller', code: '', part_number: '' });
  const b = candidate({ url: 'https://b.example/m10', domain: 'b.example', source_type: 'specialized_store', code: '', part_number: '' });
  const one = vision.chooseMatch([a], clues);
  const two = vision.chooseMatch([a, b], clues);
  assert.equal(one.status, 'PRODUTO_NAO_CONFIRMADO');
  assert.equal(two.status, 'CONFIRMADO');
  assert.equal(two.match_level, 'provavel');
});
