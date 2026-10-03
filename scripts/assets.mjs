import {readFile} from 'node:fs/promises';
export async function readAssets(root) {
 const assets={};
 for(const [name,type]of [['index.html','text/html; charset=utf-8'],['style.css','text/css; charset=utf-8'],['app.js','text/javascript; charset=utf-8'],['fixtures/catalog.json','application/json'],['fixtures/planning-scenario.json','application/json'],['LICENSE','text/plain; charset=utf-8']]) assets['/'+name]={body:await readFile(new URL(name,root),'utf8'),type};
 return assets;
}
