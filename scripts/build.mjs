import { mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,'dist');
if(output!==root+sep+'dist') throw new Error('Unsafe output directory');
await rm(output,{recursive:true,force:true});
await mkdir(output,{recursive:true});
const web=new Set(['.html','.css','.js','.svg','.png','.jpg','.jpeg','.webp','.avif','.gif','.ico','.woff','.woff2','.ttf','.mp4','.webm']);
let count=0;
async function copy(directory,destination){
  await mkdir(destination,{recursive:true});
  for(const entry of await readdir(directory,{withFileTypes:true})){
    if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;
    const source=resolve(directory,entry.name),target=resolve(destination,entry.name);
    if(entry.isDirectory())await copy(source,target);
    else if(web.has(extname(entry.name).toLowerCase())){await copyFile(source,target);count++;}
  }
}
for(const file of ['index.html','collection.html','about.html','product.html']){await copyFile(resolve(root,file),resolve(output,file));count++;}
for(const dir of ['admin','css','js','products','public'])await copy(resolve(root,dir),resolve(output,dir));
console.log(`Built ${count} storefront assets in dist. Server modules, credentials, tests and database files are excluded.`);
