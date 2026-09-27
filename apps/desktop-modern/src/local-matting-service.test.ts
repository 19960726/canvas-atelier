import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createLocalMattingService } from './local-matting-service.js';
const request={width:8,height:8,rgba:new Uint8Array(256),bounds:{x:0,y:0,width:1,height:1},regions:[]};
it('reports timeout even when a native worker cannot finish termination',async()=>{
  vi.useFakeTimers();
  try {
    const worker=Object.assign(new EventEmitter(),{terminate:vi.fn(()=>new Promise<number>(()=>{}))});
    const run=createLocalMattingService(()=>worker,100);
    const result=run(request);const rejected=expect(result).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(101);await rejected;
    await expect(run(request)).rejects.toThrow(/处理中/);
  } finally {vi.useRealTimers();}
});
it('rejects concurrent work and frees the worker after source-sized output',async()=>{
  const worker=Object.assign(new EventEmitter(),{terminate:vi.fn(async()=>0)}),spawn=vi.fn(()=>worker);
  const run=createLocalMattingService(spawn);
  const first=run(request);
  await expect(run(request)).rejects.toThrow(/处理中/);
  worker.emit('message',{ok:true,result:{width:8,height:8,rgba:new Uint8Array(256)}});
  await expect(first).resolves.toMatchObject({width:8,height:8});
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it('rejects altered geometry and terminates timed-out local processing',async()=>{
  vi.useFakeTimers();
  try {
    const worker=Object.assign(new EventEmitter(),{terminate:vi.fn(async()=>0)});
    const run=createLocalMattingService(()=>worker,100);
    const result=run(request);const rejected=expect(result).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(101);await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    const second=run(request);const altered=expect(second).rejects.toThrow(/尺寸/);
    worker.emit('message',{ok:true,result:{width:4,height:16,rgba:new Uint8Array(256)}});await altered;
  } finally {vi.useRealTimers();}
});
