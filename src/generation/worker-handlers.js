'use strict';
const { Pool }=require('pg');
const { ProviderContractService }=require('../providers/provider-contract-service');
const { createStorageFromEnv }=require('../storage');
const { createGenerationJobHandler,createGenerationProviderRegistry,GenerationWorker }=require('./generation-worker');
const { createProductionVisualProviderRegistry,createVisualAssetProductionHandler }=require('./visual-asset-production');

let pool;
let handlers;
function getHandlers(){
  if(handlers)return handlers;
  if(!process.env.DATABASE_URL)throw Object.assign(new Error('DATABASE_URL is required for generation handlers'),{code:'PROVIDER_NOT_CONFIGURED',retryable:false});
  if(!process.env.FORGE_PROVIDER_CONTRACT_SIGNING_SECRET)throw Object.assign(new Error('FORGE_PROVIDER_CONTRACT_SIGNING_SECRET is required for generation handlers'),{code:'CONTRACT_UNAVAILABLE',retryable:false});
  pool=new Pool({connectionString:process.env.DATABASE_URL,max:Number.parseInt(process.env.PG_POOL_MAX||'5',10)});
  const storage=createStorageFromEnv();
  const visualRegistry=createProductionVisualProviderRegistry({pool});
  const directVisual=new GenerationWorker({pool,storage,providerRegistry:visualRegistry});
  const assets=createVisualAssetProductionHandler({pool,storage,providerRegistry:visualRegistry});
  handlers={
    'workflow:assets':assets,
    'generation:image':(payload,job)=>directVisual.execute({...payload,capability:'image-generation'},job),
    'generation:video':(payload,job)=>directVisual.execute({...payload,capability:'video-generation'},job),
    'generation:text':null,
  };
  return handlers;
}
function generationText(payload,job){
  const h=getHandlers();
  if(!h['generation:text']){const registry=createGenerationProviderRegistry();registry.pool=pool;registry.contractService=new ProviderContractService({pool});h['generation:text']=createGenerationJobHandler({pool,storage:createStorageFromEnv(),providerRegistry:registry});}
  return h['generation:text'](payload,job);
}
module.exports={handlers:{'workflow:assets':(payload,job)=>getHandlers()['workflow:assets'](payload,job),'generation:image':(payload,job)=>getHandlers()['generation:image'](payload,job),'generation:video':(payload,job)=>getHandlers()['generation:video'](payload,job),'generation:text':generationText}};
