import type { EventEmitter } from 'node:events';
import { parseLocalMattingRequest, type LocalMattingRequest, type LocalMattingResult } from '../../../packages/desktop-core/src/local-matting.js';
type LocalWorker = Pick<EventEmitter,'once' | 'removeAllListeners'> & { terminate(): Promise<number> };

export function createLocalMattingService(spawn: (request: LocalMattingRequest) => LocalWorker, timeoutMs=180_000) {
  let busy=false;
  return async (value: unknown): Promise<LocalMattingResult> => {
    if(busy)throw new Error('已有图层正在本地处理中，请等待完成');
    const request=parseLocalMattingRequest(value);busy=true;
      return await new Promise<LocalMattingResult>((resolve,reject)=>{
        let worker: LocalWorker;
        try {worker=spawn(request);} catch(error){busy=false;reject(error);return;}
        let finished=false;
        const finish=(error?: Error,result?: LocalMattingResult)=>{
          if(finished)return;finished=true;clearTimeout(timer);
          // Native inference may not terminate promptly. Settle the caller now,
          // while keeping the resource occupied until the worker actually exits.
          void worker.terminate().then(()=>{busy=false;worker.removeAllListeners();},()=>{});
          if(error)reject(error);else resolve(result!);
        };
        const timer=setTimeout(()=>finish(new Error('本地精修超时，原图和已有图层已保留')),timeoutMs);
        worker.once('message',(message: {ok?: boolean;error?: string;result?: LocalMattingResult})=>{
          if(!message?.ok||!message.result){finish(new Error(message?.error||'本地精修失败'));return;}
          const result=message.result;
          if(result.width!==request.width||result.height!==request.height||!(result.rgba instanceof Uint8Array)||result.rgba.length!==request.rgba.length)
            finish(new Error('本地精修输出尺寸与原图不一致'));
          else finish(undefined,result);
        });
        worker.once('error',(error: Error)=>finish(error));
        worker.once('exit',()=>{busy=false;finish(new Error('本地精修意外退出，原图和已有图层已保留'));});
      });
  };
}
