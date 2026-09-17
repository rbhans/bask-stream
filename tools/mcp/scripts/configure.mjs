#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { stationOrigin } from '../dist/config.js';

const {values:args}=parseArgs({options:{url:{type:'string'},username:{type:'string'},ca:{type:'string'},config:{type:'string'},help:{type:'boolean'}}});
if(args.help) {
  console.log('Run npm run configure, or node scripts/configure.mjs [--url https://station] [--username operator] [--ca /path/to/issuer.pem] [--config /path/to/station.connection.json]. Password is prompted privately or read from BASKSTREAM_PASSWORD. Writes stay disabled.');
  process.exit(0);
}
let muted=false;
const output=new Writable({write(chunk,encoding,callback){if(!muted)process.stdout.write(chunk,encoding);callback();}});
const rl=readline.createInterface({input:process.stdin,output,terminal:Boolean(process.stdin.isTTY)});
async function ask(prompt,secret=false) {
  if(!process.stdin.isTTY) throw new Error('Missing setup input. Use --url, --username and BASKSTREAM_PASSWORD for noninteractive setup.');
  const pending=rl.question(prompt);
  muted=secret;
  try { return await pending; } finally { muted=false;if(secret)process.stdout.write('\n'); }
}
try {
  const target=path.resolve(args.config || path.join(os.homedir(),'.bask-stream/config.json'));
  const url=stationOrigin(args.url || await ask('Niagara URL (https://...): '));
  if(!url.startsWith('https://')) throw new Error('Connection setup requires HTTPS.');
  const username=args.username || await ask('Niagara username: ');
  const password=process.env.BASKSTREAM_PASSWORD || process.env.BASK_STREAM_PASSWORD || await ask('Niagara password (hidden): ',true);
  if(!username.trim() || !password) throw new Error('Username and password are required.');
  const caFile=args.ca ? path.resolve(args.ca) : undefined;
  if(caFile) await fs.access(caFile);
  try {
    await fs.access(target);
    if((await ask('A saved connection exists. Replace it? [y/N]: ')).toLowerCase()!=='y') throw new Error('Existing connection kept.');
  } catch(error) { if(error.code!=='ENOENT') throw error; }
  await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
  const temp=target+`.${process.pid}.tmp`;
  await fs.writeFile(temp,JSON.stringify({stationUrl:url,username,password,verifyTls:true,...(caFile?{caFile}:{}),timeoutMs:45000,allowWrites:false,allowAlarmActions:false,allowTagWrites:false,allowRawOperations:false},null,2)+'\n',{mode:0o600,flag:'wx'});
  await fs.rename(temp,target);
  console.log(`Connection saved: ${target}\nTLS verification is on. Station writes are off. Start a new Codex task to use this connection.`);
} catch(error) { console.error(error.message);process.exitCode=1; }
finally {rl.close();}
