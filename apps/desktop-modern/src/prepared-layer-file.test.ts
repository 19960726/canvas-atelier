import {expect,it,vi} from 'vitest';
import {withPreparedLayerFile} from './prepared-layer-file.js';
it('preserves the durable acknowledgement and primary failure when temporary cleanup fails',async()=>{
 const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
 const io={mkdtemp:vi.fn(async()=>'/temp/canvas-refined-owned'),writeFile:vi.fn(async()=>{}),rm:vi.fn(async()=>{throw new Error('EBUSY');}),rmdir:vi.fn(async()=>{})};
 try{
  const ack={currentRevision:42,project:{id:'owned'}};
  await expect(withPreparedLayerFile('/temp',new Uint8Array([1]),async()=>ack,io as never)).resolves.toBe(ack);
  await expect(withPreparedLayerFile('/temp',new Uint8Array([1]),async()=>{throw new Error('original import failed');},io as never)).rejects.toThrow('original import failed');
 }finally{warning.mockRestore();}
});
