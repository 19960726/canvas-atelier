import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

// Build-time only: the packaged app never installs dependencies or downloads models.
const source=resolve(process.argv[2] || '');
if(!process.argv[2])throw new Error('Pass the prepared offline runtime directory');
const destination=resolve(import.meta.dirname,'../build/local-matting-runtime');
const expectedVersion='4.3.0';
const manifest=JSON.parse(await readFile(join(source,'node_modules/@huggingface/transformers/package.json'),'utf8'));
if(manifest.version!==expectedVersion)throw new Error('Unexpected Transformers.js runtime version');
const models=[
  ['Xenova/slimsam-77-uniform','7c8459c48dabad6291b384c97be46c451c25d6c4'],
  ['Xenova/vitmatte-small-composition-1k','6bc1297f6140f055a227b6d2cfe8c093281f35d2'],
];
await mkdir(destination,{recursive:true});
await cp(join(source,'node_modules'),join(destination,'node_modules'),{recursive:true});
await cp(join(source,'package-lock.json'),join(destination,'package-lock.json'));
const lock=JSON.parse(await readFile(join(destination,'package-lock.json'),'utf8'));
if(lock.packages?.['']?.dependencies)lock.packages[''].dependencies['@huggingface/transformers']=expectedVersion;
await writeFile(join(destination,'package-lock.json'),JSON.stringify(lock,null,2));
await writeFile(join(destination,'package.json'),JSON.stringify({private:true,dependencies:{'@huggingface/transformers':expectedVersion}},null,2));
await cp(join(source,'node_modules/@huggingface/transformers/LICENSE'),join(destination,'APACHE-2.0.txt'));
await writeFile(join(destination,'MODEL-NOTICES.txt'),`Offline image matting models (unmodified ONNX weights):
SlimSAM by Zigeng Chen et al.; ONNX conversion by Xenova.
https://huggingface.co/Xenova/slimsam-77-uniform
Revision 7c8459c48dabad6291b384c97be46c451c25d6c4. Apache-2.0.
ViTMatte by Jingfeng Yao, Xinggang Wang, Shusheng Yang and Baoyuan Wang (HUST Vision Lab); ONNX conversion by Xenova.
https://huggingface.co/hustvl/vitmatte-small-composition-1k
https://huggingface.co/Xenova/vitmatte-small-composition-1k
Revision 6bc1297f6140f055a227b6d2cfe8c093281f35d2. Apache-2.0 model weights.
See APACHE-2.0.txt. Dependency license files remain alongside their packages in node_modules.
`);
const files=[];
async function inventory(root,prefix='') {
  for(const item of await readdir(root,{withFileTypes:true})){
    const path=join(root,item.name),relative=join(prefix,item.name);
    if(item.isDirectory())await inventory(path,relative);
    else {const bytes=await readFile(path);files.push({path:relative,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
  }
}
for(const [id,revision] of models){
  const relative=join('model-cache',id,revision);
  await cp(join(source,relative),join(destination,relative),{recursive:true});
}
await inventory(join(destination,'model-cache'),'model-cache');
await writeFile(join(destination,'runtime-manifest.json'),JSON.stringify({transformers:expectedVersion,models,files,offline:true},null,2));
console.log(JSON.stringify({destination,models:models.length,files:files.length}));
