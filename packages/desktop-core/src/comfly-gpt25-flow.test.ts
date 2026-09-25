import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createComflyProviderService, createSecureProviderCredentialStore } from './provider-bridge';
import { createSolidPng } from './test/png-fixture';

const png = createSolidPng(2, 2, [42, 126, 168, 128]);
const json = (value: unknown) => ({ ok:true, status:200, json:async () => value });

describe('Comfly GPT 2.5 complete generation flow', () => {
  it.each(['flare', 'sunburst'].flatMap(variant => [false,true].flatMap(edit =>
    [false,true].map(direct => ({variant,edit,direct})))))('$variant edit=$edit direct=$direct returns one managed result without resubmitting', async ({variant,edit,direct}) => {
    const root=await mkdtemp(join(tmpdir(),'canvas-gpt25-flow-'));
    try {
      let polls=0;
      const fetch=vi.fn(async (url: string) => {
        if (url.includes('/tasks/')) {
          polls++;
          return json({ code:'success', data:{ task_id:'gpt25-fixture', status:polls===1?'IN_PROGRESS':'SUCCESS', progress:polls===1?'40%':'100%',
            data:polls===1?{}:{data:[{b64_json:Buffer.from(png).toString('base64')}]},
          } });
        }
        return json(direct?{ data:[{b64_json:Buffer.from(png).toString('base64')}] }:{task_id:'gpt25-fixture'});
      });
      const vault=createSecureProviderCredentialStore({ appDataRoot:root, safeStorage:{
        isEncryptionAvailable:() => true,
        encryptString:(s:string) => Buffer.from(s), decryptString:(b:Uint8Array) => Buffer.from(b).toString(),
      } });
      const storeGeneratedImage=vi.fn(async () => ({assetId:'a'.repeat(16),width:2880,height:2880}));
      const modelId=`gpt-image-2.5-${variant}-4k`;
      const service=createComflyProviderService({appDataRoot:root, credentialStore:vault, fetch, storeGeneratedImage,
        readManagedGenerationImages:async () => edit?[{bytes:png,mediaType:'image/png' as const}]:[],
        profiles:[{ provider:'comfly',modelRoute:'gpt25',modelId,displayName:modelId,capabilities:['image_generation','image_edit','async_tasks'] }],
      });
      await service.configure({token:'fixture-token'});
      const task=await service.submitImageJob({jobId:'gpt25-job',provider:'comfly',modelRoute:'gpt25',prompt:'Preserve product shape',
        sessionId:'gpt25-session',conversationId:'gpt25-conversation',referenceAssetIds:edit?['b'.repeat(16)]:[],
        aspectRatio:'1:1',resolution:'4K',quality:'high',outputCount:1,imageOutputFormat:'png',imageBackground:'auto',
      });
      expect(fetch.mock.calls[0]![0]).toBe(`https://ai.comfly.org/v1/images/${edit?'edits':'generations'}?async=true`);
      if (!direct) await expect(service.pollImageJob({provider:'comfly',providerTaskId:task.providerTaskId})).resolves.toMatchObject({status:'running',progress:0.4});
      const result=await service.pollImageJob({provider:'comfly',providerTaskId:task.providerTaskId});
      expect(result).toMatchObject({status:'completed',result:{assetId:'a'.repeat(16),width:2880,height:2880}});
      await expect(service.pollImageJob({provider:'comfly',providerTaskId:task.providerTaskId})).resolves.toEqual(result);
      expect(storeGeneratedImage).toHaveBeenCalledExactlyOnceWith('gpt25-session',Uint8Array.from(png),'image/png');
      expect(fetch).toHaveBeenCalledTimes(direct?1:3);
    } finally {
      await rm(root,{recursive:true,force:true});
    }
  });
});
