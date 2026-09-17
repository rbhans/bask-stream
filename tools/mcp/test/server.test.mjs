import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { encode, decode } from '@msgpack/msgpack';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig, configFor, assertOperationAllowed, assertOrdScope } from '../dist/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('secure defaults, exact password, legacy config, origin and operation gates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bask-config-'));
  try {
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({stationUrl:'https://station.example', username:'operator', password:' trailing ', allowedOrdPrefixes:['slot:/AHU/']}));
    const cfg = await loadConfig(dir, {BASKSTREAM_CONFIG:configPath});
    assert.equal(cfg.verifyTls, true);
    assert.equal(cfg.password, ' trailing ');
    assert.equal(configFor(cfg,{station_url:'https://station.example/'}),cfg);
    assert.throws(()=>configFor(cfg,{station_url:'https://other.example'}));
    for(const op of ['write','write_tags','write_relations','ack_alarm','future_unknown']) assert.throws(()=>assertOperationAllowed(cfg,op));
    assertOperationAllowed({...cfg,allowTagWrites:true},'write_tags');
    assert.throws(()=>assertOperationAllowed({...cfg,allowTagWrites:true},'write'));
    assertOrdScope(cfg,{points:['slot:/AHU/temp']});
    assert.throws(()=>assertOrdScope(cfg,{targets:[{ord:'slot:/AHU/temp',add:[{endpoint:'slot:/outside'}]}]}));
    await fs.writeFile(configPath, JSON.stringify({stationUrl:'https://station.example', rejectUnauthorized:false, enableMutations:true}));
    const legacy=await loadConfig(dir,{BASKSTREAM_CONFIG:configPath});
    assert.equal(legacy.verifyTls,false); assert.equal(legacy.allowWrites,true); assert.equal(legacy.allowTagWrites,false);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('stdio tools exercise station protocol and enforce mutation and credential boundaries', async () => {
  const requests=[];
  let httpRequests=0;
  const server=http.createServer((req,res)=>{ httpRequests++; res.setHeader('Content-Type','application/json');res.end(JSON.stringify({apiVersion:'1.5'})); });
  const ws=new WebSocketServer({server});
  ws.on('connection',socket=>socket.on('message',body=>{
    const request=decode(body); requests.push(request);
    if(request.op==='read' && request.points[0]==='slot:/bad-frame') { socket.send(Buffer.from([0xc1])); return; }
    socket.send(encode({op:`${request.op}_result`, id:request.id, targets:[{ord:request.ords?.[0],ok:true}],received:request}));
  }));
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bask-mcp-'));
  const configPath=path.join(dir,'config.json');
  await fs.writeFile(configPath,JSON.stringify({stationUrl:`http://127.0.0.1:${server.address().port}`,username:'test',password:'test',allowRawOperations:true}));
  const client=new Client({name:'bask-regression',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[process.env.BASKSTREAM_TEST_ENTRY || path.join(root,'dist/index.js')],cwd:dir,
    env:{PATH:process.env.PATH,BASKSTREAM_CONFIG:configPath},stderr:'pipe'});
  try {
    await client.connect(transport);
    const tools=(await client.listTools()).tools;
    for(const name of ['baskstream_read_tags','baskstream_write_tags','baskstream_write_relations']) assert.ok(tools.some(t=>t.name===name));
    const call=(name,args)=>client.callTool({name,arguments:args});
    let result=await call('baskstream_read_tags',{ords:['slot:/AHU'],dictionary:'hs'});
    assert.ok(!result.isError); assert.equal(requests.at(-1).op,'read_tags'); assert.equal(requests.at(-1).includeRelations,true);
    result=await call('baskstream_read_points',{points:['slot:/bad-frame']}); assert.equal(result.isError,true);
    result=await call('baskstream_read_tags',{ords:['slot:/AHU']}); assert.ok(!result.isError);
    for(const op of ['write_tags','write_relations','write','ack_alarm','new_operation']) {
      result=await call('baskstream_call_raw',{op,fields:{ord:'slot:/AHU'}}); assert.equal(result.isError,true);
      assert.ok(!requests.some(r=>r.op===op));
    }
    const before=httpRequests;
    result=await call('baskstream_read_tags',{ords:['slot:/AHU'],station_url:'http://127.0.0.1:1'});
    assert.equal(result.isError,true); assert.equal(httpRequests,before);
    result=await call('baskstream_write_relations',{targets:[{ord:'slot:/AHU',remove:[{id:'hs:siteRef',direction:'inboud'}]}]});
    assert.equal(result.isError,true);
  } finally {
    await client.close(); ws.close(); server.close();
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('TLS rejects unknown certificates; configured CA and verified SCRAM succeed; false server proof fails', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bask-tls-'));
  const cert=path.join(dir,'cert.pem'), key=path.join(dir,'key.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  let invalidProof=false, firstBare='', first='', requestCount=0;
  const salt=Buffer.from('test-salt');
  const hmac=(k,s)=>crypto.createHmac('sha256',k).update(s).digest();
  const server=https.createServer({key:await fs.readFile(key),cert:await fs.readFile(cert)},async(req,res)=>{
    requestCount++;
    let body='';for await(const chunk of req) body+=chunk;
    if(req.url==='/stream/health') {res.statusCode=req.headers.cookie?.includes('auth=test')?200:401;res.end('{"apiVersion":"1.5"}');return;}
    if(req.url==='/login') {res.end('j_security_check');return;}
    if(body.startsWith('action=sendClientFirstMessage')) {
      firstBare=body.split('clientFirstMessage=n,,')[1];
      const nonce=firstBare.split(',r=')[1];
      first=`r=${nonce}server,s=${salt.toString('base64')},i=4096`;res.end(first);return;
    }
    if(body.startsWith('action=sendClientFinalMessage')) {
      const final=body.split('clientFinalMessage=')[1].split(',p=')[0];
      const salted=crypto.pbkdf2Sync('secret',salt,4096,32,'sha256');
      const signature=hmac(hmac(salted,'Server Key'),`${firstBare},${first},${final}`);
      res.setHeader('Set-Cookie','auth=test; Path=/; Secure');
      res.end(`v=${invalidProof?Buffer.alloc(32).toString('base64'):signature.toString('base64')}`);return;
    }
    res.end('ok');
  });
  const sockets=new WebSocketServer({server});
  sockets.on('connection',socket=>socket.on('message',body=>{const r=decode(body);socket.send(encode({id:r.id,op:'capabilities',capabilities:{apiVersion:'1.5'}}));}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  async function diagnose(withCA) {
    const file=path.join(dir,'connection.json');
    await fs.writeFile(file,JSON.stringify({stationUrl:`https://127.0.0.1:${server.address().port}`,username:'test',password:'secret',...(withCA?{caFile:cert}:{})}));
    const client=new Client({name:'tls-test',version:'1.0.0'});
    const transport=new StdioClientTransport({command:process.execPath,args:[process.env.BASKSTREAM_TEST_ENTRY || path.join(root,'dist/index.js')],cwd:dir,env:{PATH:process.env.PATH,BASKSTREAM_CONFIG:file},stderr:'pipe'});
    try {await client.connect(transport);return await client.callTool({name:'baskstream_diagnose_connection',arguments:{}});}
    finally {await client.close();}
  }
  try {
    assert.equal((await diagnose(false)).isError,true);assert.equal(requestCount,0);
    assert.ok(!(await diagnose(true)).isError);
    invalidProof=true;
    const failure=await diagnose(true);assert.equal(failure.isError,true);assert.match(failure.content[0].text,/signature verification failed/);
  } finally {sockets.close();server.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('setup saves a private config and initializer preserves user files', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bask-setup-'));
  try {
    const file=path.join(dir,'station.connection.json');
    const output=execFileSync(process.execPath,[path.join(root,'scripts/configure.mjs'),'--url','https://station.example','--username','operator','--config',file],{env:{PATH:process.env.PATH,BASKSTREAM_PASSWORD:'do-not-print'},encoding:'utf8'});
    assert.ok(!output.includes('do-not-print'));
    const cfg=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(cfg.verifyTls,true);assert.equal(cfg.allowTagWrites,false);
    if(process.platform!=='win32')assert.equal((await fs.stat(file)).mode&0o777,0o600);
    const init=path.resolve(root,'../codex-plugin/bask-stream/scripts/init-station-workspace.mjs');
    execFileSync(process.execPath,[init,dir]);
    const notes=path.join(dir,'station.context/README.md');await fs.writeFile(notes,'User notes');
    execFileSync(process.execPath,[init,dir]);
    assert.equal(await fs.readFile(notes,'utf8'),'User notes');
    assert.equal(JSON.parse(await fs.readFile(file,'utf8')).password,'do-not-print');
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
