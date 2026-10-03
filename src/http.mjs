import {qlooClient,ApiError} from './qloo.mjs';
import {runAgent} from './agent.mjs';
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
async function readBody(request) {
  if(!request.body)throw new ApiError('Invalid JSON.',400);
  const reader=request.body.getReader(),parts=[];let size=0;
  try{
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>150000){await reader.cancel();throw new ApiError('The catalogue is too large.',413);}parts.push(value);}
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export function createApi({exampleRanking,fetchImpl=fetch}={}) {
  let windowStart=0,calls=0,active=0;
  return async function api(request,env={}) {
    const url=new URL(request.url);
    const configured=typeof env.QLOO_API_KEY==='string'&&!!env.QLOO_API_KEY.trim();
    if(url.pathname==='/api/status'&&request.method==='GET')return json({qlooConfigured:configured,provider:'Qloo hackathon',mode:'example available; live requires server access'});
    if(!['/api/search','/api/plan'].includes(url.pathname))return json({error:'Not found'},404);
    if(request.method!=='POST')return json({error:'Use POST'},405);
    if(request.headers.get('origin') && request.headers.get('origin')!==url.origin)return json({error:'Cross-origin requests are not accepted.'},403);
    if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return json({error:'Send application/json.'},415);
    let body;
    try{body=await readBody(request);}catch(error){return json({error:error instanceof ApiError?error.message:'Invalid JSON.'},error instanceof ApiError?error.status:400);}
    if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'Send a JSON object.'},400);
    const live=url.pathname==='/api/search'||body.mode==='live';
    if(live){
      if(!configured)return json({error:'Qloo access is not configured on this server. Use the example while access is being set up.'},503);
      const now=Date.now();if(now-windowStart>60000){windowStart=now;calls=0;}
      if(calls>=20||active>=2)return json({error:'The shared demo is busy. Try again in a minute.'},429);
      calls++;active++;
    }
    try{
      const client=qlooClient({apiKey:env.QLOO_API_KEY,fetchImpl});
      return json(url.pathname==='/api/search'?{entities:await client.search(body.query,body.medium)}:await runAgent(body,{client,exampleRanking}));
    }catch(error){return json({error:error instanceof ApiError||error instanceof TypeError?error.message:'The run failed. No replacement result was generated.'},error instanceof ApiError?error.status:error instanceof TypeError?400:500);}
    finally{if(live)active--;}
  };
}
