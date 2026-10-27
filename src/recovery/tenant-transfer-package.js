'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const fss=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {sha256}=require('./tenant-transfer-crypto');
const execFileAsync=promisify(execFile);
async function tempDir(prefix){return fs.mkdtemp(path.join(os.tmpdir(),prefix))}
async function fileHash(file){const h=crypto.createHash('sha256');for await(const c of fss.createReadStream(file))h.update(c);return h.digest('hex')}
async function splitFile(file,chunkSize){const out=[];let ordinal=0;for await(const chunk of fss.createReadStream(file,{highWaterMark:chunkSize})){const bytes=Buffer.from(chunk);out.push({ordinal:ordinal++,sha256:sha256(bytes),sizeBytes:bytes.length,bytes})}return out}
async function writeDeterministicArchive(dir,out){const tar=path.join(dir,'package.tar');await execFileAsync('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','-cf',tar,'-C',dir,'catalog.json','manifest.json','snapshot.json','replay.json','artifacts']);const gz=await execFileAsync('gzip',['-n','-c',tar],{encoding:'buffer',maxBuffer:1024*1024*1024});await fs.writeFile(out,gz.stdout);return out}
async function writeStreamToFile(stream,file){await pipeline(stream,fss.createWriteStream(file,{flags:'wx',mode:0o600}))}
module.exports={tempDir,fileHash,splitFile,writeDeterministicArchive,writeStreamToFile,Readable,pipeline};
