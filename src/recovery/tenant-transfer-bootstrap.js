'use strict';
const path=require('node:path');
const workerPath=path.resolve(__dirname,'../worker.js');
const worker=require(workerPath);const original=worker.loadHandlers;worker.loadHandlers=({pool}={})=>{const handlers=original({pool});const {createTransferHandlers}=require('./tenant-transfer');return Object.assign(handlers,createTransferHandlers({pool,storage:require('../storage').createStorageFromEnv()}))};require.cache[require.resolve(workerPath)].exports=worker;
