import {planCycle,replanCycle} from './planner.mjs';
import {ApiError,UUID,MEDIA} from './qloo.mjs';

export async function runAgent(input,{client,exampleRanking}={}) {
  const {catalog,constraints,mode='example',references=[],previousPlan=null,unavailableItemIds=[]}=input??{};
  if(!['example','live'].includes(mode))throw new ApiError('Choose example or live mode.');
  // Validate all untrusted input before contacting an external service.
  const baseline={orderedItemIds:catalog?.items?.map(i=>i.id)??[],provenance:{kind:'synthetic-ranking',notice:'Validation order only; not used as a live ranking.'}};
  planCycle({catalog,constraints,ranking:baseline});
  if(!Array.isArray(unavailableItemIds)||unavailableItemIds.some(id=>!baseline.orderedItemIds.includes(id)))throw new ApiError('An unavailable resource was not found in the catalogue.');
  if(previousPlan)replanCycle({catalog,constraints,ranking:baseline,previousPlan,unavailableItemIds});
  const trace=[{tool:'check_catalogue',summary:`Checked ${catalog.items.length} resources against language, duration, availability, permissions and budget.`}];
  let ranking,evidence=[];
  if(mode==='example') {
    ranking={orderedItemIds:(exampleRanking??baseline.orderedItemIds).filter(id=>baseline.orderedItemIds.includes(id)),provenance:{kind:'synthetic-ranking',notice:'Authored example order. No Qloo request, affinity score or model response.'}};
    trace.push({tool:'load_example_order',summary:'Used the clearly labelled example priority order. No API call.'});
  } else {
    if(!client)throw new ApiError('Qloo client is unavailable.',503);
    if(!Array.isArray(references)||references.length<1||references.length>5||references.some(r=>!UUID.test(r.id??'')))throw new ApiError('Resolve and choose one to five cultural references before live planning.');
    const buckets=[];
    for(const medium of MEDIA) {
      const candidates=catalog.items.filter(i=>i.medium===medium&&i.availability==='available'&&!unavailableItemIds.includes(i.id)&&UUID.test(i.qlooId??'')&&i.qlooConfirmed===true);
      if(!candidates.length)continue;
      if(candidates.length>10)throw new ApiError('This prototype supports at most ten resolved catalogue resources per medium.');
      if(new Set(candidates.map(c=>c.qlooId)).size!==candidates.length)throw new ApiError('Two resources resolve to the same Qloo entity. Keep one discussion activity per entity.');
      const entities=await client.rank(references.map(r=>r.id),candidates.map(c=>c.qlooId),medium);
      evidence.push({medium,requestedIds:candidates.map(c=>c.qlooId),returned:entities.map((e,index)=>({entityId:e.id,name:e.name,rank:index+1}))});
      buckets.push(entities.map(e=>candidates.find(c=>c.qlooId===e.id).id));
      trace.push({tool:'rank_catalogue',summary:`Qloo ranked ${entities.length} of ${candidates.length} confirmed ${medium} resources. Missing results were left out.`});
    }
    if(!buckets.length)throw new ApiError('Resolve catalogue resources to Qloo identities before live planning.');
    const orderedItemIds=[];
    for(let i=0;i<10;i++)for(const bucket of buckets)if(bucket[i])orderedItemIds.push(bucket[i]);
    ranking={orderedItemIds,provenance:{kind:'external-order',evidenceRef:`run:${crypto.randomUUID()}`,notice:'Live Qloo ordering within each medium, interleaved book/movie/artist. Ranks across media are not comparable affinity scores.'}};
  }
  ranking.orderedItemIds=ranking.orderedItemIds.filter(id=>!unavailableItemIds.includes(id));
  const plan=previousPlan?replanCycle({catalog,constraints,ranking,previousPlan,unavailableItemIds}):planCycle({catalog,constraints,ranking});
  trace.push({tool:previousPlan?'repair_cycle':'solve_cycle',summary:plan.status==='feasible'?`Found three sessions; ${plan.objective.preservedSessionCount??0} prior assignments retained.`:'No complete plan satisfies the current constraints. No activity was invented.'});
  trace.push({tool:'validate_cycle',summary:plan.status==='feasible'?`Verified distinct resources, ${plan.totals.distinctMedia} media and total cost ${plan.totals.costMinor} minor units.`:plan.failures.map(f=>f.message).join(' ')});
  return {mode,plan,evidence,trace,generatedAt:new Date().toISOString(),agent:'Bounded deterministic planning agent; no language model is used.'};
}
