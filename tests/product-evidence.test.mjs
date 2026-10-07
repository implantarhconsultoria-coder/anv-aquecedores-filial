import test from 'node:test';
import assert from 'node:assert/strict';
import {parseModelJSON,validateFields,scoreCandidate,rankCandidates,collectSearchSources,publicURL} from '../lib/product-evidence.mjs';
import {pageEvidence,isPublicAddress} from '../lib/source-fetch.mjs';
import {buildQueries} from '../api/product_research.mjs';
import {parseCookies,readSession} from '../api/vision_node.mjs';
import {functionalError} from '../lib/research-ai.mjs';
// Contract/security tests use isolated input vectors; they are not real product identification tests.
test('Responses API text and Chat Completions text decode without accepting truncation',()=>{
 assert.deepEqual(parseModelJSON({output:[{type:'message',content:[{type:'output_text',text:'{"codes":[]}'}]}]}),{codes:[]});
 assert.deepEqual(parseModelJSON({choices:[{message:{content:[{type:'text',text:'```json\n{"codes":[]}\n```'}]}}]}),{codes:[]});
 assert.throws(()=>parseModelJSON({choices:[{finish_reason:'length',message:{content:'{}'}}]}),/model_incomplete/);
 assert.throws(()=>parseModelJSON({status:'incomplete',output_text:'{}'}),/model_incomplete/);
 assert.throws(()=>parseModelJSON({output:[]}),/empty_model_response/);
 assert.throws(()=>parseModelJSON({output_text:'[]'}),/model_invalid_json/);
});
test('import excludes unsupported fields, made-up quotations and partial numeric matches',()=>{
 const result=validateFields({name:{value:'Peça',quote:'Nome: Peça'},brand:{value:'Outra',quote:'Marca: Outra'},voltage:{value:'110',quote:'Tensão: 220 V'},price:{value:'100',quote:'Preço 100'},package_weight_g:{value:'10',quote:'Peso 10'}},'Nome: Peça Tensão: 220 V Preço 100 Peso 10');
 assert.deepEqual(result.fields,{name:'Peça'});
});
test('exact part number alone offers confirmation, appearance alone never reaches 80',()=>{
 assert.equal(scoreCandidate({codes:['ABC-123']},{fields:{name:'Peça',code:'ABC-123'}}).score,80);
 assert.ok(scoreCandidate({brand:'Marca',model:'M1'},{fields:{name:'Peça',brand:'Marca',model:'M1'},image_url:'https://example.com/a.jpg',visual:{compared:true,similarity:1}}).score<80);
});
test('95+ requires exact identity evidence and matching reference image',()=>{
 const hints={codes:['ABC-123'],brand:'Marca',model:'M1'};
 const c={fields:{name:'Peça',code:'ABC-123',brand:'Marca',model:'M1'},image_url:'https://example.com/a.jpg',visual:{compared:true,similarity:.9,conflicts:[]}};
 assert.ok(scoreCandidate(hints,c).score>=95);
 assert.ok(scoreCandidate(hints,{...c,image_url:null}).score<95);
 assert.ok(scoreCandidate(hints,{...c,visual:{compared:true,similarity:1,conflicts:['conector diferente']}}).score<80);
 assert.ok(scoreCandidate(hints,{...c,fields:{...c.fields,code:'XYZ-999'}}).score<80);
});
test('malformed scores cannot poison ranking; only 3 candidates are shown',()=>{
 const c={fields:{name:'Peça',code:'ABCD'},image_url:'https://example.com/a.jpg',visual:{compared:true,similarity:'not-a-number'}};
 assert.equal(scoreCandidate({codes:['ABCD']},c).score,80);
 assert.equal(rankCandidates({codes:['ABCD']},Array.from({length:5},()=>c)).length,3);
});
test('unknown source types do not outrank evidence; manufacturer breaks ties',()=>{
 const c={fields:{name:'Peça',code:'ABCD'}};
 const list=rankCandidates({codes:['ABCD']},[{...c,source_type:'other'},{...c,source_type:'manufacturer'}]);
 assert.equal(list[0].source_type,'manufacturer');
});
test('research produces multiple code and physical queries without injecting a brand',()=>{
 const queries=buildQueries({codes:['ABC-123'],product_type:'placa',visible_text:['ABC-123'],physical_features:['conector branco']});
 assert.ok(queries.length>=2);assert.ok(queries.every(q=>!q.includes('Rinnai')));
});
test('only tool-source URLs are collected; unsupported protocols and credentials rejected',()=>{
 const env={output:[{type:'web_search_call',action:{sources:[{url:'https://example.com/part'}]}},{type:'message',content:[{text:'https://invented.example.com'}]}]};
 assert.deepEqual(collectSearchSources(env).map(s=>s.url),['https://example.com/part']);
 for(const url of ['http://example.com','https://127.0.0.1','https://[::1]','https://a:b@example.com','https://localhost','file:///tmp/test'])assert.equal(publicURL(url),null);
});
test('source retrieval rejects private address classes before any connection',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','172.20.1.2','192.168.1.2','169.254.169.254','100.64.1.2','::1','fc00::1','::ffff:127.0.0.1'])assert.equal(isPublicAddress(ip),false,ip);
 assert.equal(isPublicAddress('8.8.8.8'),true);
});
test('page text includes JSON-LD evidence but excludes executable scripts',()=>{
 const p=pageEvidence('<title>Peça</title><script>secret()</script><script type="application/ld+json">{"@type":"Product","name":"Peça","image":"https://example.com/p.jpg"}</script><p>Marca: Marca</p>','https://example.com/p');
 assert.ok(p.text.includes('Marca: Marca'));assert.ok(p.text.includes('"name":"Peça"'));assert.ok(!p.text.includes('secret()'));assert.equal(p.image_url,'https://example.com/p.jpg');
});
test('malformed cookies cannot crash handlers; technical AI errors remain server-side',()=>{
 assert.deepEqual(parseCookies('anv_session=%ZZ'),{});assert.equal(readSession('invalid'),null);
 const e=functionalError(new Error('empty_model_response'));assert.ok(!e.detail.includes('empty_model_response'));assert.equal(e.status,502);
});
