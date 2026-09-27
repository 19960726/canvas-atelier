import {mkdtemp,writeFile,rm,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
const files={mkdtemp,writeFile,rm,rmdir};
export async function withPreparedLayerFile<T>(root:string,png:Uint8Array,importFile:(path:string)=>Promise<T>,io=files):Promise<T>{
  const directory=await io.mkdtemp(join(root,'canvas-refined-')),sourcePath=join(directory,'refined-layer.png');
  try {await io.writeFile(sourcePath,png,{flag:'wx'});return await importFile(sourcePath);}
  finally {
    // Cleanup must not replace an acknowledged durable import or its original error.
    try {await io.rm(sourcePath,{force:true});await io.rmdir(directory);} catch {console.warn('本地精修临时文件未能清理');}
  }
}
