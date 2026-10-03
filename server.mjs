import {createServer} from 'node:http';
import {createHandler} from './src/handler.mjs';
import {readAssets} from './scripts/assets.mjs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export async function createLocalServer({env={}}={}) {
 const assets=await readAssets(new URL('./',import.meta.url));
 const ranking=JSON.parse(assets['/fixtures/planning-scenario.json'].body).ranking.orderedItemIds;
 const handle=createHandler(assets,ranking);
 const server=createServer(async(req,res)=>{
 const fail=(status,error)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({error}));};
 try{
   const port=server.address().port;
   if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))return fail(403,'Use the local address printed by the server.');
   if(!req.url?.startsWith('/'))return fail(400,'Use a local request path.');
   const parts=[];let size=0;
   for await(const part of req){size+=part.length;if(size>150000)return fail(413,'Request too large');parts.push(part);}
   const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(parts)})});
   const response=await handle(request,env);
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{fail(500,'Unable to complete request');}
 });
 return server;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const port=Number(process.env.PORT||4313),server=await createLocalServer({env:{QLOO_API_KEY:process.env.QLOO_API_KEY}});
 server.listen(port,'127.0.0.1',()=>console.log(`Culture Weave: http://127.0.0.1:${server.address().port} · Qloo ${process.env.QLOO_API_KEY?'configured':'not configured'}`));
}
