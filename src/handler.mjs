import {createApi} from './http.mjs';
export function createHandler(assets,exampleRanking) {
 const api=createApi({exampleRanking});
 return async function handle(request,env={}) {
   const path=new URL(request.url).pathname;
   let response;
   if(path.startsWith('/api/'))response=await api(request,env);
   else if(!['GET','HEAD'].includes(request.method))response=new Response('Method not allowed',{status:405});
   else {
     const asset=assets[path==='/'?'/index.html':path];
     response=asset?new Response(request.method==='HEAD'?null:asset.body,{headers:{'Content-Type':asset.type,'Cache-Control':'no-cache'}}):new Response('Not found',{status:404});
   }
   response.headers.set('X-Content-Type-Options','nosniff');
   response.headers.set('Referrer-Policy','no-referrer');
   response.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
   return response;
 };
}
