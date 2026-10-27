'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const{toVtt,withOutro}=require('../src/media/ship-ready-finishing-handler-sync');
test('sidecar conversion produces WebVTT with millisecond timestamps',()=>{assert.equal(toVtt('1\n00:00:00,000 --> 00:00:01,250\nHello\n','captions.srt'),'WEBVTT\n\n00:00:00.000 --> 00:00:01.250\nHello\n');});
test('configured outro is normalized into a deterministic end-of-video overlay',()=>{const config=withOutro({outro:{text:'Thanks',durationSeconds:2},lowerThirds:[]},10);assert.equal(config.outro,null);assert.equal(config.lowerThirds[0].startSeconds,8);assert.equal(config.lowerThirds[0].endSeconds,10);assert.equal(config.lowerThirds[0].text,'Thanks');});
