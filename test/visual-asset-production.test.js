'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {parseJsonBody,shotSpec,shotCapability,createProductionVisualProviderRegistry}=require('../src/generation/visual-asset-production');

test('visual provider responses retain provider request ids and media payloads',()=>{
  const parsed=parseJsonBody({id:'req-123',artifact:{contentBase64:Buffer.from('media').toString('base64'),mediaType:'video/mp4'}});
  assert.equal(parsed.metadata.requestId,'req-123');
  assert.equal(parsed.artifacts[0].requestId,'req-123');
  assert.equal(parsed.artifacts[0].contentType,'video/mp4');
});

test('shot planning maps footage and animation scenes to executable video generation specs',()=>{
  const scene={id:'scene-4',title:'Rocket launch',type:'footage',durationSeconds:4,startSeconds:12,visual:{prompt:'cinematic rocket launch over a desert',style:'documentary',parameters:{aspectRatio:'16:9'}}};
  const spec=shotSpec(scene,0);
  assert.equal(shotCapability(scene),'video-generation');
  assert.equal(spec.shotId,'scene-4:shot:1');
  assert.equal(spec.startSeconds,12);
  assert.equal(spec.durationSeconds,4);
  assert.equal(spec.prompt,'cinematic rocket launch over a desert');
  assert.equal(spec.parameters.aspectRatio,'16:9');
});

test('production visual registry exposes only configured real providers',()=>{
  const original={...process.env};
  try{
    process.env.FORGE_IMAGE_GENERATION_COMMAND='node';
    process.env.FORGE_IMAGE_GENERATION_ARGS='-e console.log("provider")';
    delete process.env.FORGE_VIDEO_GENERATION_COMMAND;
    delete process.env.FORGE_VIDEO_GENERATION_ENDPOINT;
    const facade=createProductionVisualProviderRegistry({pool:{query:async()=>({rows:[]})}});
    assert.ok(facade.get('image-generation'));
    assert.equal(facade.get('video-generation'),null);
  }finally{
    for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];
    Object.assign(process.env,original);
  }
});

test('configured command adapter executes a real ffmpeg video provider and returns request provenance',async()=>{
  const original={...process.env};
  try{
    process.env.FORGE_VIDEO_GENERATION_COMMAND=process.execPath;
    process.env.FORGE_VIDEO_GENERATION_ARGS=`${path.join(__dirname,'fixtures','real-video-provider.js')} --input ${'${input}'} --output ${'${output}'}`;
    const facade=createProductionVisualProviderRegistry({pool:{query:async()=>({rows:[]})}});
    const provider=facade.registry.get('video-generation');
    const result=await provider.execute({prompt:'real acceptance media',parameters:{durationSeconds:1},contentType:'video/mp4',idempotencyKey:'acceptance-request-1'},{timeoutMs:30000});
    assert.equal(result.artifacts[0].contentType,'video/mp4');
    assert.ok(Buffer.isBuffer(result.artifacts[0].content));
    assert.ok(result.artifacts[0].content.length>1000);
    assert.equal(result.artifacts[0].requestId,'acceptance-request-1');
    assert.equal(result.artifacts[0].content.subarray(4,8).toString('ascii'),'ftyp');
  }finally{
    for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];
    Object.assign(process.env,original);
  }
});
