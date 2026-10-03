export const BASE_URL = 'https://hackathon.api.qloo.com';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MEDIA = ['book','movie','artist'];
export class ApiError extends Error { constructor(message,status=400){super(message);this.status=status;} }
async function readBoundedJson(response){
  const limit=1024*1024;
  if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw new ApiError('Qloo response exceeded the one-megabyte limit.',502);}
  if(!response.body)throw new ApiError('Qloo returned an empty response.',502);
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new ApiError('Qloo response exceeded the one-megabyte limit.',502);}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function qlooClient({apiKey,fetchImpl=fetch,record=()=>{}}={}) {
  let calls=0;
  async function request(endpoint,params) {
    if (typeof apiKey!=='string'||!apiKey.trim()) throw new ApiError('Qloo access is not configured on this server. The example remains available.',503);
    if (++calls>8) throw new ApiError('This run reached its eight-request limit.',429);
    const url=new URL(endpoint,BASE_URL);
    for(const [k,v] of Object.entries(params)) url.searchParams.set(k,String(v));
    let response;
    try { response=await fetchImpl(url,{headers:{'X-Api-Key':apiKey,Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(15000)}); }
    catch(error) {
      const reason=/illegal invocation/i.test(error?.message)?'fetch-context':/not a function/i.test(error?.message)?'runtime-method':/redirect/i.test(error?.message)?'redirect':/timed? ?out|timeout/i.test(error?.message)?'timeout':'network';
      console.warn('Qloo transport failure:',reason);
      throw new ApiError(`Qloo could not be reached (${reason}). No fallback or synthetic result was substituted.`,502);
    }
    const stamp={endpoint,parameters:params,status:response.status,at:new Date().toISOString()};
    record(stamp);
    if(response.status>=300&&response.status<400){
      let destination='an unverified destination';
      try{const target=new URL(response.headers.get('location'),BASE_URL);if(target.origin===BASE_URL)destination=target.pathname.split(apiKey).join('[redacted]').slice(0,100);}catch{}
      throw new ApiError(`Qloo returned HTTP ${response.status} redirect to ${destination}. No redirect was followed.`,502);
    }
    if(endpoint==='/search' && response.status===404) return [];
    if(!response.ok) throw new ApiError(`Qloo returned HTTP ${response.status}. No result was substituted.`,response.status===429?429:502);
    let payload;try{payload=await readBoundedJson(response);}catch(error){if(error instanceof ApiError)throw error;throw new ApiError('Qloo returned an unreadable response.',502);}
    const entities=endpoint==='/search'?payload?.results:payload?.results?.entities;
    if(!payload || payload.success===false || !Array.isArray(entities) || entities.length>100) throw new ApiError('Qloo response did not match the expected entity schema.',502);
    return entities.map(e=>{
      const types=endpoint==='/search'?(Array.isArray(e?.types)?e.types:null):(e?.type==='urn:entity'&&typeof e?.subtype==='string'?[e.subtype]:null);
      const identityIssue=typeof e?.entity_id!=='string'||!UUID.test(e.entity_id)?'entity ID':typeof e.name!=='string'||!e.name.trim()?'name':!types?'type':!types.every(t=>typeof t==='string')||!types.includes(params.types??params['filter.type'])?'matching type':null;
      if(identityIssue)throw new ApiError(`Qloo returned an entity without a verifiable identity (${identityIssue}).`,502);
      const rawYear=e.properties?.release_year??e.properties?.publication_year;
      const year=(Number.isInteger(rawYear)&&rawYear>=1&&rawYear<=9999)||(typeof rawYear==='string'&&/^[0-9]{1,4}$/.test(rawYear))?rawYear:null;
      const safe={id:e.entity_id,name:e.name.slice(0,250),types,year,description:typeof e.properties?.description==='string'?e.properties.description.slice(0,400):'',popularity:Number.isFinite(e.popularity)?e.popularity:null};
      // Do not return arbitrary provider metadata or echoed credentials.
      return JSON.parse(JSON.stringify(safe).split(apiKey).join('[redacted]'));
    });
  }
  return {
    async search(query,medium){
      if(typeof query!=='string'||!query.trim()||query.length>180||!MEDIA.includes(medium))throw new ApiError('Choose a medium and a title or artist of 1–180 characters.');
      return request('/search',{query:query.trim(),types:`urn:entity:${medium}`,take:5});
    },
    async rank(signals,ids,medium){
      if(!MEDIA.includes(medium)||!Array.isArray(signals)||signals.length<1||signals.length>5||!signals.every(x=>typeof x==='string'&&UUID.test(x))||!Array.isArray(ids)||ids.length<1||ids.length>20||!ids.every(x=>typeof x==='string'&&UUID.test(x)))throw new ApiError('Ranking requires verified entity IDs, up to five references and twenty resources per medium.');
      const result=await request('/v2/insights',{'filter.type':`urn:entity:${medium}`,'signal.interests.entities':signals.join(','),'filter.results.entities':ids.join(','),take:Math.min(ids.length,10)});
      if(result.some(e=>!ids.includes(e.id)||!e.types.includes(`urn:entity:${medium}`))||new Set(result.map(e=>e.id)).size!==result.length)throw new ApiError('Qloo did not respect the fixed catalogue filter. This run was stopped.',502);
      return result;
    }
  };
}
