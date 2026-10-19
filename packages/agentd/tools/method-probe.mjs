import { spawn } from 'node:child_process';
const NODE='D:/Environment/nodejs/node.exe', HOME='D:/Environment/nodejs/node_modules';
const LAB='D:/Project2/code-261013-speclock2/speclock2';
const CWD='D:/Project2/code-261013-speclock2/speclock2';
const AGENTS={
  mcode:{cmd:NODE,args:[`${HOME}/@minimax-ai/code/cli.js`,'acp']},
  dsh:{cmd:NODE,args:[`${HOME}/@deepseek-ai/dsh/lib/bin.js`,'--profile','acp']},
  pi:{cmd:NODE,args:[`${LAB}/server/pi-acp-adapter.mjs`]},
};
const name=process.argv[2]||'dsh', spec=AGENTS[name];
const child=spawn(spec.cmd,spec.args,{stdio:['pipe','pipe','pipe'],windowsHide:true});
let buf='';const pending=new Map();let id=1;
child.stdout.setEncoding('utf8');
child.stdout.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\n'))!==-1){const l=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue}
  if(m.id!=null&&pending.has(m.id)){const r=pending.get(m.id);pending.delete(m.id);r(m)}else if(m.id!=null&&m.method)child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'x'}})+'\n');}});
child.stderr.on('data',()=>{});
const req=(method,params,ms=60000)=>new Promise(res=>{const i=id++;const t=setTimeout(()=>{pending.delete(i);res({error:{message:'timeout'}})},ms);pending.set(i,v=>{clearTimeout(t);res(v)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:i,method,params})+'\n')});
await req('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false}}});
const s=await req('session/new',{cwd:CWD,mcpServers:[]});
const sid=s.result?.sessionId;
await req('session/prompt',{sessionId:sid,prompt:[{type:'text',text:'Say OK'}]},180000);
console.log(`\n=== ${name} candidate stats methods ===`);
const cands=['session/stats','session/get_stats','session/usage','session/info','session/inspect','mcode/session/usage','mcode/session/stats','session/metadata','session/get_metadata','mcp/session/stats'];
for(const m of cands){
  const r=await req(m,{sessionId:sid},20000);
  if(r.error){
    const msg=r.error.message||JSON.stringify(r.error);
    if(!/Method not found/i.test(msg)) console.log(`~ ${m}: ${msg.slice(0,120)}`);
  } else {
    console.log(`✓ ${m}: ${JSON.stringify(r.result).slice(0,600)}`);
  }
}
console.log('(only non-"Method not found" results shown)');
child.stdin.end();child.kill();process.exit(0);
