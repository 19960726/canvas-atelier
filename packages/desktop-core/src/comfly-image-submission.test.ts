import { describe, expect, it, vi } from 'vitest';
import { ComflyClient, type ComflyFetch } from '@agent-canvas/provider-comfly';
import { submitComflyImage } from './comfly-image-submission';

const legacy = ['gpt-image-1', 'gpt-image-1-2025-04-15', 'gpt-image-1-mini', 'gpt-image-1-mini-2025-10-06', 'gpt-image-1.5', 'gpt-image-1.5-2025-12-16'];
const exact = ['gpt-image-2', 'gpt-image-2-vip', 'gpt-image-2-2k', 'gpt-image-2-4k', ...['flare','sunburst'].flatMap(v => ['', '-2k', '-4k'].map(s => `gpt-image-2.5-${v}${s}`))];
const models = [...legacy, ...exact, 'gpt-image-2-all'];

describe('Comfly catalog GPT image transport matrix', () => {
  it.each(['flare', 'sunburst'].flatMap(variant => ['', '-2k', '-4k'].flatMap(suffix => [false, true].flatMap(edit => ['png', 'webp'].map(format => ({ model: `gpt-image-2.5-${variant}${suffix}`, edit, format: format as 'png' | 'webp' }))))))('$model edit=$edit forwards transparent $format explicitly', async ({ model, edit, format }) => {
    const fetch = vi.fn<ComflyFetch>(async () => ({ ok: true, status: 200, json: async () => ({ task_id: 'transparent-fixture' }) }));
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'fixture', fetch });
    await submitComflyImage(client, { provider: 'comfly', modelRoute: model, modelId: model, displayName: model, capabilities: ['image_generation', 'image_edit', 'async_tasks'] }, {
      jobId: 'transparent-fixture', provider: 'comfly', modelRoute: model, prompt: 'Isolated product', sessionId: 'fixture', conversationId: 'fixture', referenceAssetIds: [], resolution: '1K', quality: 'high', imageBackground: 'transparent', imageOutputFormat: format,
    }, 'Isolated product', edit ? [{ bytes: Uint8Array.from([137,80,78,71]), mediaType: 'image/png' }] : []);
    const [, init] = fetch.mock.calls[0]!;
    const body = edit ? await new Response(new Blob([Uint8Array.from(init!.body as Uint8Array)]), { headers: { 'content-type': init!.headers!['content-type']! } }).formData() : JSON.parse(init!.body as string);
    expect(edit ? body.get('background') : body.background).toBe('transparent');
    expect(edit ? body.get('output_format') : body.output_format).toBe(format);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('rejects transparent JPEG even for non-UI callers before provider submission', async () => {
    const fetch = vi.fn<ComflyFetch>();
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'fixture', fetch });
    await expect(async () => submitComflyImage(client, { provider: 'comfly', modelRoute: 'gpt', modelId: 'gpt-image-2.5-flare', displayName: 'GPT', capabilities: ['image_generation'] }, { jobId: 'fixture', provider: 'comfly', modelRoute: 'gpt', prompt: 'test', sessionId: 'fixture', conversationId: 'fixture', referenceAssetIds: [], imageBackground: 'transparent', imageOutputFormat: 'jpeg' }, 'test', [])).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['2K', '4K'] as const)('rejects unsupported gpt-image-2-all %s before submitting', async (size) => {
    const fetch = vi.fn<ComflyFetch>();
    const client = new ComflyClient({ baseUrl: 'https://ai.comfly.org', tokenSupplier: async () => 'fixture', fetch });
    await expect(client.generateImage({ model: 'gpt-image-2-all', prompt: 'test', size })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(models.flatMap(model => [false,true].map(edit => ({model,edit}))))('$model edit=$edit preserves model and routes references as image files', async ({model,edit}) => {
    const fetch = vi.fn<ComflyFetch>(async () => ({ok:true,status:200,json:async () => ({data:[{b64_json:'iVBORw0KGgo='}]})}));
    const client = new ComflyClient({baseUrl:'https://ai.comfly.org',tokenSupplier:async ()=>'fixture',fetch});
    await submitComflyImage(client, {provider:'comfly', modelRoute:'fixture-gpt',modelId:model,displayName:model,capabilities:['image_generation','image_edit']}, {
      jobId:'fixture',sessionId:'fixture',conversationId:'fixture',provider:'comfly',modelRoute:'fixture-gpt',prompt:'Preserve shape', referenceAssetIds:[],resolution:'1K',aspectRatio:'1:1',quality:'high',outputCount:1,
    }, 'Preserve shape', edit?[{bytes:Uint8Array.from([137,80,78,71]),mediaType:'image/png'}]:[]);
    const [url,init]=fetch.mock.calls[0]!;
    expect(url).toBe(`https://ai.comfly.org/v1/images/${edit?'edits':'generations'}`);
    if(edit){
      expect(init?.headers?.['content-type']).toMatch(/^multipart\/form-data;/);
      const form=await new Response(new Blob([Uint8Array.from(init!.body as Uint8Array)]),{headers:{'content-type':init!.headers!['content-type']!}}).formData();
      expect(form.get('model')).toBe(model);
      expect(form.get('size')).toBe('1024x1024');
      expect(form.has('aspect_ratio')).toBe(false);
      const file=form.get('image') as File;
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(Uint8Array.from([137,80,78,71]));
    } else {
      expect(JSON.parse(init!.body as string)).toMatchObject({model,size:'1024x1024'});
    }
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(legacy)('%s preserves a square aspect at the default 2K tier', async model => {
    const fetch=vi.fn<ComflyFetch>(async()=>({ok:true,status:200,json:async()=>({data:[{url:'https://example.com/image.png'}]})}));
    const client=new ComflyClient({baseUrl:'https://ai.comfly.org',tokenSupplier:async()=>'fixture',fetch});
    await client.generateImage({model,prompt:'Square product',size:'2K',aspect_ratio:'1:1'});
    const request=JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(request.size).toBe('1024x1024');
    expect(request).not.toHaveProperty('aspect_ratio');
  });
});
