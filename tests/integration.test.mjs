import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {qlooClient,BASE_URL} from '../src/qloo.mjs';
import {runAgent} from '../src/agent.mjs';
import {createApi} from '../src/http.mjs';
import {createLocalServer} from '../server.mjs';
import {request as httpRequest} from 'node:http';
import {once} from 'node:events';
const catalog=JSON.parse(await readFile(new URL('../fixtures/catalog.json',import.meta.url)));
const scenario=JSON.parse(await readFile(new URL('../fixtures/planning-scenario.json',import.meta.url)));
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const input=()=>({catalog:structuredClone(catalog),constraints:structuredClone(scenario.constraints),mode:'example'});
const entity=(n,medium)=>({entity_id:id(n),name:'Fixture '+n,types:['urn:entity:'+medium]});
const insightEntity=(n,medium)=>({entity_id:id(n),name:'Fixture '+n,type:'urn:entity',subtype:'urn:entity:'+medium});
const req=(path,body,headers={})=>new Request('https://example.test'+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
test('example agent plans and repairs while preserving two assignments without API',async()=>{
 const data=input();let network=0;const opts={exampleRanking:scenario.ranking.orderedItemIds,client:{rank(){network++;throw new Error('must not call')}}};
 const first=await runAgent(data,opts);assert.equal(first.plan.sessions.length,3);assert.equal(first.mode,'example');assert.equal(first.evidence.length,0);
 const removed=first.plan.sessions[1].itemId;data.catalog.items.find(x=>x.id===removed).availability='unavailable';
 const second=await runAgent({...data,previousPlan:first.plan,unavailableItemIds:[removed]},opts);assert.equal(second.plan.objective.preservedSessionCount,2);assert.equal(second.plan.changes.length,1);assert.equal(network,0);
});
test('live agent uses returned shortlist order and omits unreturned resources',async()=>{
 const data=input();data.mode='live';data.references=[{id:id(99)}];data.catalog.items.slice(0,6).forEach((x,i)=>Object.assign(x,{qlooId:id(i+1),qlooConfirmed:true}));
 const calls=[];const result=await runAgent(data,{client:{async rank(signals,ids,medium){calls.push({signals,ids,medium});return [{id:ids[0]}];}}});
 assert.equal(calls.length,3);assert.equal(result.plan.status,'feasible');assert.equal(result.evidence.length,3);assert.equal(result.plan.provenance.ranking.kind,'external-order');
 assert.deepEqual(result.referenceIds,[id(99)]);
 assert.deepEqual(result.plan.sessions.map(x=>x.itemId),data.catalog.items.slice(0,3).map(x=>x.id));
});
test('live provider errors propagate; no fake fallback plan',async()=>{
 const data=input();data.mode='live';data.references=[{id:id(99)}];Object.assign(data.catalog.items[0],{qlooId:id(1),qlooConfirmed:true});
 await assert.rejects(()=>runAgent(data,{client:{rank:async()=>{throw new Error('provider rejected')}}}),/provider rejected/);
});
test('provider sends only documented host, header and params',async()=>{
 let seen;const client=qlooClient({apiKey:'fixture-key',fetchImpl:async(url,options)=>{seen={url,options};return Response.json({results:{entities:[insightEntity(1,'book')]}});}});
 await client.rank([id(99)],[id(1)],'book');assert.equal(seen.url.origin,BASE_URL);assert.equal(seen.url.pathname,'/v2/insights');assert.equal(seen.options.headers['X-Api-Key'],'fixture-key');assert.equal(seen.options.redirect,'manual');assert.equal(seen.url.searchParams.get('filter.results.entities'),id(1));assert.ok(!seen.url.href.includes('fixture-key'));
});

test('provider redirects are not followed and foreign locations are not exposed',async()=>{
 let calls=0;const client=qlooClient({apiKey:'fixture-key',fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://foreign.example/fixture-key'}});}});
 await assert.rejects(()=>client.search('title','book'),error=>error.status===502&&/No redirect was followed/.test(error.message)&&!error.message.includes('fixture-key')&&!error.message.includes('foreign.example'));
 assert.equal(calls,1);
});

test('Insights uses type and subtype while Search still requires its types array',async()=>{
 const correct=insightEntity(1,'book');
 const client=qlooClient({apiKey:'fixture-key',fetchImpl:async()=>Response.json({results:{entities:[correct]}})});
 assert.deepEqual((await client.rank([id(99)],[id(1)],'book'))[0].types,['urn:entity:book']);
 for(const entry of [{...correct,subtype:'urn:entity:movie'},{...correct,type:'urn:entity:book'},{...correct,subtype:undefined},entity(1,'book')]){
  const bad=qlooClient({apiKey:'fixture-key',fetchImpl:async()=>Response.json({results:{entities:[entry]}})});
  await assert.rejects(()=>bad.rank([id(99)],[id(1)],'book'),error=>error.status===502);
 }
 const wrongSearch=qlooClient({apiKey:'fixture-key',fetchImpl:async()=>Response.json({results:[correct]})});
 await assert.rejects(()=>wrongSearch.search('book','book'),error=>error.status===502);
});
test('provider rejects ignored filter, duplicate IDs and wrong schema',async()=>{
 for(const payload of [{results:{entities:[insightEntity(2,'book')]}},{results:{entities:[insightEntity(1,'book'),insightEntity(1,'book')]}},{results:{entities:[{name:'No id'}]}}]){
 const client=qlooClient({apiKey:'fixture-key',fetchImpl:async()=>Response.json(payload)});await assert.rejects(()=>client.rank([id(99)],[id(1)],'book'));
 }
});
test('missing credentials prevent network requests',async()=>{let network=0;const api=createApi({fetchImpl:()=>{network++;}});const result=await api(req('/api/search',{query:'book',medium:'book'}));assert.equal(result.status,503);assert.equal(network,0);});
test('API rejects cross-origin, wrong type and invalid constraints before network',async()=>{
 let network=0;const api=createApi({fetchImpl:()=>{network++;}}),env={QLOO_API_KEY:'fixture-key'};
 assert.equal((await api(req('/api/search',{}, {Origin:'https://hostile.test'}),env)).status,403);
 assert.equal((await api(req('/api/plan',{}, {'Content-Type':'text/plain'}),env)).status,415);
 const data=input();data.mode='live';data.constraints.slots[0].maxMinutes=-1;assert.equal((await api(req('/api/plan',data),env)).status,400);assert.equal(network,0);
});
test('search response never passes arbitrary metadata or echoed credentials',async()=>{
 const client=qlooClient({apiKey:'fixture-key',fetchImpl:async()=>Response.json({results:[{...entity(1,'book'),name:'fixture-key',internal:{secret:'fixture-key'}}]})});
 const result=await client.search('title','book');assert.ok(!JSON.stringify(result).includes('fixture-key'));assert.equal(result[0].internal,undefined);
});

test('API rejects null and non-object JSON without throwing or contacting Qloo',async()=>{
 let network=0;const api=createApi({fetchImpl:()=>{network++;}});
 for(const body of [null,[],true,'text',42]){
  const response=await api(req('/api/plan',body),{QLOO_API_KEY:'fixture-key'});
  assert.equal(response.status,400);assert.match((await response.json()).error,/JSON object/);
 }
 assert.equal(network,0);
});

test('API request limit counts UTF-8 bytes and validates exact JSON media type',async()=>{
 const api=createApi();
 const oversized=await api(req('/api/plan',{padding:'é'.repeat(80000)}));
 assert.equal(oversized.status,413);
 assert.equal((await api(req('/api/plan',input(),{'Content-Type':'application/jsonp'}))).status,415);
 assert.equal((await api(req('/api/plan',input(),{'Content-Type':'Application/JSON; charset=utf-8'}))).status,200);
});

test('malformed upstream envelopes are 502 responses, not client errors',async()=>{
 for(const payload of [null,{},[],{results:null}]){
  const api=createApi({fetchImpl:async()=>Response.json(payload)});
  const response=await api(req('/api/search',{query:'title',medium:'book'}),{QLOO_API_KEY:'fixture-key'});
  assert.equal(response.status,502);
  assert.match((await response.json()).error,/expected entity schema/);
 }
});

test('search rejects wrong media and array-shaped identities; year metadata is scalar only',async()=>{
 for(const result of [{...entity(1,'book'),entity_id:[id(1)]},entity(1,'artist')]){
  const client=qlooClient({apiKey:'fixture-key',fetchImpl:async()=>Response.json({results:[result]})});
  await assert.rejects(()=>client.search('title','book'),error=>error.status===502);
 }
 const client=qlooClient({apiKey:'fixture-key',fetchImpl:async()=>Response.json({results:[{...entity(1,'book'),properties:{release_year:{unexpected:'provider metadata'}}}]})});
 const results=await client.search('title','book');assert.equal(results[0].year,null);
});

test('array-shaped ranking IDs are rejected before a provider call',async()=>{
 let calls=0;const client=qlooClient({apiKey:'fixture-key',fetchImpl:()=>{calls++;}});
 await assert.rejects(()=>client.rank([[id(99)]],[id(1)],'book'),error=>error.status===400);
 assert.equal(calls,0);
});

test('oversized provider bodies are bounded with or without a content-length header',async()=>{
 for(const declared of [true,false]){
  let cancelled=false;
  const stream=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1024*1024+1));},cancel(){cancelled=true;}});
  const client=qlooClient({apiKey:'fixture-key',fetchImpl:async()=>new Response(stream,{headers:declared?{'content-length':'1048577'}:{}})});
  await assert.rejects(()=>client.search('title','book'),error=>error.status===502&&/one-megabyte/.test(error.message));
  assert.equal(cancelled,true);
 }
});

test('local Node server rejects a foreign Host even when Origin matches it',async t=>{
 const server=await createLocalServer();server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const port=server.address().port;
 const response=await new Promise((resolve,reject)=>{
  const request=httpRequest({host:'127.0.0.1',port,path:'/api/status',headers:{Host:'foreign.example',Origin:'http://foreign.example'}},result=>{
   let body='';result.on('data',chunk=>{body+=chunk;});result.on('end',()=>resolve({status:result.statusCode,body:JSON.parse(body)}));
  });request.on('error',reject);request.end();
 });
 assert.equal(response.status,403);assert.match(response.body.error,/local address/);
 const valid=await fetch(`http://127.0.0.1:${port}/api/status`);assert.equal(valid.status,200);assert.equal((await valid.json()).qlooConfigured,false);
});

test('unavailable IDs are excluded from an initial plan without a previous plan',async()=>{
 const data=input();data.unavailableItemIds=['local:movie:spirited-away'];
 const result=await runAgent(data,{exampleRanking:scenario.ranking.orderedItemIds});
 assert.equal(result.plan.status,'feasible');
 assert.ok(result.plan.sessions.every(session=>session.itemId!=='local:movie:spirited-away'));
});

test('invalid previous plan is rejected before live ranking starts',async()=>{
 const data=input();data.mode='live';data.references=[{id:id(99)}];data.previousPlan={status:'invalid'};
 data.catalog.items.slice(0,6).forEach((item,index)=>Object.assign(item,{qlooId:id(index+1),qlooConfirmed:true}));
 let calls=0;
 await assert.rejects(()=>runAgent(data,{client:{async rank(){calls++;return [];}}}),/previous plan/);
 assert.equal(calls,0);
});
