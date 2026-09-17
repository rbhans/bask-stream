#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(process.argv[2] || process.cwd());
await fs.mkdir(path.join(root,'station.context'),{recursive:true});
const files={
  'station.context/README.md':'# Station context\n\nRecord verified station identity, branch paths, equipment mappings, source and observation date. Keep unknowns in open-questions.md. Keep credentials and time-series records out of these files.\n',
  'station.context/open-questions.md':'# Open questions\n\nUnverified station relationships and meanings go here.\n',
  'station.connection.example.json':JSON.stringify({stationUrl:'https://station.example',username:'operator',verifyTls:true,allowWrites:false,allowAlarmActions:false,allowTagWrites:false,allowRawOperations:false},null,2)+'\n'
};
for(const [name,contents] of Object.entries(files)) {
  try { await fs.writeFile(path.join(root,name),contents,{flag:'wx'}); }
  catch(error) { if(error.code!=='EEXIST') throw error; }
}
const ignore=path.join(root,'.gitignore');
let previous='';try {previous=await fs.readFile(ignore,'utf8');} catch(error){if(error.code!=='ENOENT')throw error;}
if(!previous.split(/\r?\n/).includes('station.connection.json')) await fs.appendFile(ignore,`${previous && !previous.endsWith('\n')?'\n':''}station.connection.json\n`);
console.log(`Station workspace ready: ${root}`);
