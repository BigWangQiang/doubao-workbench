import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';

const state = vi.hoisted(() => new Map<string, unknown>());
vi.mock('electron', () => ({ app: { getPath: (): string => '/test-profile' }, safeStorage: { isEncryptionAvailable: (): boolean => true, decryptString: (): string => 'fake-test-key' } }));
vi.mock('fs/promises', () => ({ readFile: vi.fn().mockResolvedValue('{"apiKeyCipher":"dGVzdA=="}') }));
vi.mock('../../main/ipc/lalorAuth', () => ({ requireLalorGenerationAccess: vi.fn().mockResolvedValue(undefined) }));
vi.mock('dns/promises', () => ({ lookup: vi.fn().mockResolvedValue({address:'93.184.216.34',family:4}) }));
vi.mock('https', () => ({ default: { get: vi.fn() } }));
vi.mock('../../main/services/workbenchCanvasStorage', () => ({
  canvasRead: async (key: string): Promise<unknown> => state.get(key) ?? null,
  canvasWrite: async (key: string, value: unknown): Promise<void> => { state.set(key, value); },
  saveCanvasBytes: vi.fn(), getCanvasResource: vi.fn(),
}));

import { canvasApiRequest, createCanvasApiTask, queryCanvasApiTask, downloadCanvasMedia, startCanvasApiRecovery } from '../../main/services/workbenchCanvasApi';
import https from 'https';
import { saveCanvasBytes, getCanvasResource } from '../../main/services/workbenchCanvasStorage';
import * as fs from 'fs/promises';
import { requireLalorGenerationAccess } from '../../main/ipc/lalorAuth';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK5cAAAAASUVORK5CYII=', 'base64');
const KEY_HASH = createHash('sha256').update('fake-test-key').digest('hex');

describe('workbench public API protocol', (): void => {
  beforeEach((): void => {
    state.clear(); vi.clearAllMocks();
    vi.mocked(requireLalorGenerationAccess).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue('{"apiKeyCipher":"dGVzdA=="}');
    vi.mocked(saveCanvasBytes).mockResolvedValue({ id: 'result', publicUrl: 'lalor-canvas://resources/result', localPath: '/saved/result.png', mimeType: 'image/png', kind: 'image', size: PNG.length });
  });
  afterEach((): void => { vi.unstubAllGlobals(); });

  it('reports HTML safely and never retries a submission', async (): Promise<void> => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<!doctype html><html>private-upstream-key</html>', {status: 200}));
    vi.stubGlobal('fetch', fetchMock);
    await expect(canvasApiRequest('/images/generations', {model:'image',prompt:'test'})).rejects.toThrow(/非 JSON.*HTTP 200/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://aigc.lalun.cn/api/v1/images/generations');
  });

  it('propagates JSON API failures even when HTTP status is 200', async (): Promise<void> => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({error:{message:'模型已停用'}})));
    await expect(canvasApiRequest('/models')).rejects.toThrow('模型已停用');
  });

  it('uploads local image/video/audio bytes before submitting once and preserves reference order', async (): Promise<void> => {
    vi.mocked(getCanvasResource).mockImplementation(async (id) => ({id,kind:id.split('-')[0],mimeType:id.startsWith('image')?'image/png':id.startsWith('audio')?'audio/wav':'video/mp4',size:PNG.length,localPath:'/private/'+id,publicUrl:'lalor-canvas://resources/'+id}));
    vi.mocked(fs.readFile).mockImplementation(async (file): Promise<Buffer | string> => String(file).endsWith('workbench-api.json') ? '{"apiKeyCipher":"dGVzdA=="}' : PNG);
    const kinds:string[]=[];
    const fetchMock = vi.fn().mockImplementation(async (url:string, init:RequestInit): Promise<Response> => {
      if(url.endsWith('/resources')) { const form=init.body as FormData; const kind=String(form.get('kind')); kinds.push(kind); expect(form.get('purpose')).toBe('temporary_reference'); expect(init.headers).toMatchObject({Authorization:'Bearer fake-test-key'}); return Response.json({id:'site-'+kinds.length,kind,status:'ready',cleanupToken:'receipt-'+kinds.length}); }
      const body=JSON.parse(String(init.body));
      expect(body.reference_images).toEqual([{resource_id:'site-1'},{resource_id:'site-2'}]);
      expect(body.reference_videos).toEqual([{resource_id:'site-3'}]);
      expect(body.reference_audios).toEqual([{resource_id:'site-4'}]);
      expect(String(init.body)).not.toContain('/private/');
      return Response.json({id:'remote-task',status:'queued'});
    }); vi.stubGlobal('fetch',fetchMock);
    const task=await createCanvasApiTask({projectId:'canvas',input:{mode:'video',prompt:'test',metadata:{nodeId:'node-1'},config:{model:'video'},referenceImages:[{storageKey:'resource:image-1'},{storageKey:'resource:image-2'}],referenceVideos:[{storageKey:'resource:video-1'}],referenceAudios:[{storageKey:'resource:audio-1'}]}});
    await vi.waitFor(():void=>{expect(state.get('api-task:'+task.id)).toMatchObject({remoteId:'remote-task'});});
    expect(kinds).toEqual(['image','image','video','audio']);
    expect(state.get('api-task:'+task.id)).toMatchObject({temporaryResourceIds:['site-1','site-2','site-3','site-4']});
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(JSON.parse(String(task.inputJson))).toMatchObject({metadata:{nodeId:'node-1'}});
  });

  it('does not submit video when an upload fails and never substitutes the local ID', async (): Promise<void> => {
    vi.mocked(getCanvasResource).mockResolvedValue({id:'local',kind:'image',mimeType:'image/png',size:PNG.length,localPath:'/private/local',publicUrl:'lalor-canvas://resources/local'});
    vi.mocked(fs.readFile).mockImplementation(async (file): Promise<Buffer | string> => String(file).endsWith('workbench-api.json') ? '{"apiKeyCipher":"dGVzdA=="}' : PNG);
    const fetchMock=vi.fn().mockResolvedValue(Response.json({error:{message:'上传失败'}},{status:503})); vi.stubGlobal('fetch',fetchMock);
    const task=await createCanvasApiTask({input:{mode:'video',prompt:'test',config:{model:'video'},referenceImages:[{storageKey:'resource:local'}]}});
    await vi.waitFor(():void=>{expect(state.get('api-task:'+task.id)).toMatchObject({status:'failed'});});
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0][0]).toContain('/resources');
  });

  it('uses a public URL ahead of a local storage key and saves the remote task ID', async (): Promise<void> => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({id:'remote-task',status:'queued'}));
    vi.stubGlobal('fetch', fetchMock);
    const task = await createCanvasApiTask({input:{mode:'video',prompt:'test',config:{model:'video'},referenceImages:[{storageKey:'resource:local-file',resourceId:'local-file',url:'https://media.example/reference.png'}]}});
    await vi.waitFor((): void => { expect(state.get('api-task:'+task.id)).toMatchObject({remoteId:'remote-task'}); });
    const request = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(request.reference_images).toEqual([{url:'https://media.example/reference.png'}]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('submits the documented image JSON with the complete model ID and saves base64 output', async (): Promise<void> => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({data:[{b64_json:PNG.toString('base64')}]}));
    vi.stubGlobal('fetch', fetchMock);
    const task = await createCanvasApiTask({input:{mode:'image',prompt:'test image',config:{model:'gpt-image-2-route',size:'auto',quality:'auto',count:4}}});
    await vi.waitFor((): void => { expect(state.get('api-task:'+task.id)).toMatchObject({status:'succeeded'}); });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://aigc.lalun.cn/api/v1/images/generations');
    expect(init.headers).toMatchObject({Authorization:'Bearer fake-test-key','Content-Type':'application/json'});
    expect(JSON.parse(init.body)).toEqual({model:'gpt-image-2-route',prompt:'test image',n:1});
    expect(saveCanvasBytes).toHaveBeenCalledWith({bytes:PNG,mimeType:'image/png',kind:'image'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uploads local reference bytes in order through multipart without exposing file paths', async (): Promise<void> => {
    vi.mocked(getCanvasResource).mockResolvedValue({id:'local',kind:'image',mimeType:'image/png',size:PNG.length,localPath:'/private/local.png',publicUrl:'lalor-canvas://resources/local'});
    vi.mocked(fs.readFile).mockImplementation(async (file): Promise<Buffer | string> => String(file).endsWith('workbench-api.json') ? '{"apiKeyCipher":"dGVzdA=="}' : PNG);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({data:[{b64_json:PNG.toString('base64')}]}));
    vi.stubGlobal('fetch', fetchMock);
    const task = await createCanvasApiTask({input:{mode:'image',prompt:'reference test',config:{model:'gpt-image-2-route'},referenceImages:[{storageKey:'resource:local'},{dataUrl:'data:image/png;base64,'+PNG.toString('base64')}]}});
    await vi.waitFor((): void => { expect(state.get('api-task:'+task.id)).toMatchObject({status:'succeeded'}); });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://aigc.lalun.cn/api/v1/images/edits');
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('model')).toBe('gpt-image-2-route');
    const files = init.body.getAll('image') as File[];
    expect(files.map(file => file.name)).toEqual(['reference-1.png','reference-2.png']);
    expect(Buffer.from(await files[0].arrayBuffer())).toEqual(PNG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not turn a reference request into text-to-image when the server route is missing', async (): Promise<void> => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('404 page not found',{status:404}));
    vi.stubGlobal('fetch', fetchMock);
    const task = await createCanvasApiTask({input:{mode:'image',prompt:'reference test',config:{model:'image'},referenceImages:[{dataUrl:'data:image/png;base64,'+PNG.toString('base64')}]}});
    await vi.waitFor((): void => { expect(state.get('api-task:'+task.id)).toMatchObject({status:'failed',error:expect.stringContaining('/api/v1/images/edits 返回 404')}); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saveCanvasBytes).not.toHaveBeenCalled();
  });

  it('rejects malformed image results and empty prompts without a false success', async (): Promise<void> => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({data:{url:'invalid'}}));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createCanvasApiTask({input:{mode:'image',prompt:' ',config:{model:'image'}}})).rejects.toThrow('提示词');
    expect(state.size).toBe(0); expect(fetchMock).not.toHaveBeenCalled();
    const task = await createCanvasApiTask({input:{mode:'image',prompt:'test',config:{model:'image'}}});
    await vi.waitFor((): void => { expect(state.get('api-task:'+task.id)).toMatchObject({status:'failed',error:expect.stringContaining('data 图片数组')}); });
    expect(saveCanvasBytes).not.toHaveBeenCalled();
  });

  it('blocks generation before submission or local task creation when membership is invalid', async (): Promise<void> => {
    vi.mocked(requireLalorGenerationAccess).mockRejectedValue(new Error('会员已过期'));
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(createCanvasApiTask({input:{mode:'image',prompt:'test',config:{model:'image'}}})).rejects.toThrow('会员已过期');
    expect(fetchMock).not.toHaveBeenCalled(); expect(state.size).toBe(0);
  });

  it('retains a persisted task when polling fails after a page refresh', async (): Promise<void> => {
    state.set('api-task:known',{id:'known',remoteId:'remote',status:'running',projectId:'canvas',continuePolling:true});
    const fetchMock=vi.fn().mockRejectedValue(new Error('network down')); vi.stubGlobal('fetch',fetchMock);
    const task=await queryCanvasApiTask('known');
    expect(task).toMatchObject({id:'known',remoteId:'remote',status:'running',continuePolling:true});
    expect(task.stage).toContain('重连原任务');
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });

  it('honors the Node lookup all contract and never forwards the Key on a redirect', async (): Promise<void> => {
    const seen:Array<Record<string,unknown>>=[];
    vi.mocked(https.get).mockImplementation(((url:URL, options:any, done:any):any=>{
      seen.push(options.headers);
      options.lookup(url.hostname,{all:true},(error:unknown,addresses:unknown):void=>{expect(error).toBeNull();expect(addresses).toEqual([{address:'93.184.216.34',family:4}]);});
      options.lookup(url.hostname,{all:false},(error:unknown,address:string,family:number):void=>{expect(address).toBe('93.184.216.34');expect(family).toBe(4);});
      const request=Object.assign(new EventEmitter(),{setTimeout:vi.fn(),destroy:vi.fn()});
      queueMicrotask(():void=>{
        const redirect=seen.length===1;
        const response=Object.assign(new PassThrough(),{statusCode:redirect?307:200,headers:redirect?{location:'https://cdn.example/result.mp4'}:{'content-type':'video/mp4'}});
        done(response); response.end(Buffer.from('video'));
      }); return request;
    }) as any);
    await downloadCanvasMedia('https://aigc.lalun.cn/api/v1/videos/remote/content',true);
    expect(seen).toEqual([{Authorization:'Bearer fake-test-key'},{}]);
  });

  it('downloads a successful original task in the background and does not generate again', async (): Promise<void> => {
    state.set('api-task:finished',{id:'finished',remoteId:'remote',status:'running',continuePolling:true,apiKeyHash:KEY_HASH,temporaryResourceIds:['temp-image','temp-video'],temporaryCleanupTokens:{'temp-image':'receipt-image','temp-video':'receipt-video'}});
    const fetchMock=vi.fn().mockImplementation(async (url:string, init:RequestInit): Promise<Response> => {
      if (init.method === 'DELETE') {
        expect(state.get('api-task:finished')).toMatchObject({status:'succeeded',resultJson:expect.any(String)});
        expect(JSON.parse(String(init.body))).toMatchObject({task_id:'remote',cleanup_token:expect.stringContaining('receipt-')});
        return Response.json({id:url.split('/').pop(),deleted:true});
      }
      return Response.json({status:'succeeded',progress:100});
    }); vi.stubGlobal('fetch',fetchMock);
    let release:()=>void=()=>undefined;
    vi.mocked(https.get).mockImplementation(((_url:any,_options:any,done:any):any=>{
      const req=Object.assign(new EventEmitter(),{setTimeout:vi.fn(),destroy:vi.fn()});
      release=():void=>{const res=Object.assign(new PassThrough(),{statusCode:200,headers:{'content-type':'video/mp4'}});done(res);res.end(Buffer.from('0000ftypisom0000'));};
      return req;
    }) as any);
    vi.mocked(saveCanvasBytes).mockResolvedValue({id:'video-result',kind:'video',mimeType:'video/mp4',size:16,publicUrl:'lalor-canvas://resources/video-result',localPath:'/saved.mp4'});
    expect(await queryCanvasApiTask('finished')).toMatchObject({status:'running',remoteCompleted:true,progress:99});
    await vi.waitFor(():void=>{expect(https.get).toHaveBeenCalled();});
    expect(await queryCanvasApiTask('finished')).toMatchObject({remoteCompleted:true});
    release();
    await vi.waitFor(():void=>{expect(state.get('api-task:finished')).toMatchObject({status:'succeeded',remoteId:'remote',temporaryResourceIds:[]});});
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(fetchMock.mock.calls.slice(1).map((call) => [call[0], call[1].method])).toEqual([
      ['https://aigc.lalun.cn/api/v1/resources/temp-image', 'DELETE'],
      ['https://aigc.lalun.cn/api/v1/resources/temp-video', 'DELETE'],
    ]);
  });

  it('keeps an existing website resource out of the temporary cleanup list', async (): Promise<void> => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({id:'remote-existing'})); vi.stubGlobal('fetch',fetchMock);
    const task=await createCanvasApiTask({input:{mode:'video',prompt:'test',config:{model:'video'},referenceImages:[{resource_id:'user-original'}]}});
    await vi.waitFor(():void=>{expect(state.get('api-task:'+task.id)).toMatchObject({remoteId:'remote-existing',temporaryResourceIds:[]});});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('persists failed cleanup without delaying the result and retries after restart', async (): Promise<void> => {
    state.set('api-task:cleanup',{id:'cleanup',remoteId:'remote',status:'succeeded',resultJson:'{"video":{"storageKey":"resource:result"}}',apiKeyHash:KEY_HASH,temporaryResourceIds:['temp'],temporaryCleanupTokens:{temp:'receipt'}});
    const fetchMock=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Response.json({id:'temp',deleted:true})); vi.stubGlobal('fetch',fetchMock);
    expect(await queryCanvasApiTask('cleanup')).toMatchObject({status:'succeeded'});
    await vi.waitFor(():void=>{expect(state.get('api-task:cleanup')).toMatchObject({cleanupStatus:'pending',temporaryResourceIds:['temp']});});
    const saved=state.get('api-task:cleanup') as Record<string,unknown>;
    state.set('api-task:cleanup',{...saved,nextCleanupAt:0}); state.set('api-task-ids',['cleanup']);
    const stop=startCanvasApiRecovery();
    try { await vi.waitFor(():void=>{expect(state.get('api-task:cleanup')).toMatchObject({status:'succeeded',cleanupStatus:'completed',temporaryResourceIds:[]});}); }
    finally { stop(); }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every((call)=>call[1].method==='DELETE')).toBe(true);
  });

  it('does not delete with a changed key or before the local result is saved', async (): Promise<void> => {
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    state.set('api-task:wrong-key',{id:'wrong-key',remoteId:'remote',status:'succeeded',resultJson:'{}',apiKeyHash:'different-key',temporaryResourceIds:['temp'],temporaryCleanupTokens:{temp:'receipt'}});
    await queryCanvasApiTask('wrong-key');
    await vi.waitFor(():void=>{expect(state.get('api-task:wrong-key')).toMatchObject({cleanupStatus:'pending'});});
    state.set('api-task:no-result',{id:'no-result',remoteId:'remote',status:'succeeded',apiKeyHash:KEY_HASH,temporaryResourceIds:['temp']});
    await queryCanvasApiTask('no-result');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
