import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import {readAssets} from './assets.mjs';
const root=new URL('../',import.meta.url),dist=new URL('dist/server/',root);
await mkdir(new URL('src/',dist),{recursive:true});
for(const file of ['qloo.mjs','planner.mjs','agent.mjs','http.mjs','handler.mjs'])await copyFile(new URL('src/'+file,root),new URL('src/'+file,dist));
const assets=await readAssets(root),ranking=JSON.parse(assets['/fixtures/planning-scenario.json'].body).ranking.orderedItemIds;
await writeFile(new URL('index.js',dist),`import {createHandler} from './src/handler.mjs';\nconst handle=createHandler(${JSON.stringify(assets)},${JSON.stringify(ranking)});\nexport default {fetch:handle};\n`);
console.log('Built dependency-free Cloudflare Worker in dist/server/index.js');
