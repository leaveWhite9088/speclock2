import { spawn } from 'node:child_process';
const NODE='D:/Environment/nodejs/node.exe', CWD='D:/Project2/code-261013-speclock2/speclock2';
const AG=process.argv[2]||'dsh';
const SPEC={mcode:[`D:/Environment/nodejs/node_modules/@minimax-ai/code/cli.js`,'acp'],dsh:[`D:/Environment/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js`,'--profile','acp']}[AG];
function conn(){
  const child=spawn(NODE,SPEC,{stdio:['pipe','pipe','pipe'],windowsHide:true});
  let buf='';const pending=new Map();let id=1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\n'))!==-1){const l=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue}
    if(m.id!=null&&pending.has(m.id)){const r=pending.get(m.id);pending.delete(m.id);r(m)}else if(m.id!=null&&m.method)child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'x'}})+'\n');}});
  child.stderr.on('data',()=>{});
  const req=(method,params,ms=90000)=>new Promise(res=>{const i=id++;const t=setTimeout(()=>{pending.delete(i);res({error:{message:'timeout'}})},ms);pending.set(i,v=>{clearTimeout(t);res(v)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:i,method,params})+'\n')});
  return {child,req};
}
const flat=(o=[])=>o.flatMap(x=>Array.isArray(x.options)?flat(x.options):[{value:x.value,name:x.name}]);
const s=conn();
await s.req('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false}}});
const nw=await s.req('session/new',{cwd:CWD,mcpServers:[]});
const sid=nw.result.sessionId;
const mo=nw.result.configOptions.find(o=>o.id==='model');
const vals=flat(mo.options).map(o=>o.value);
const target=vals[vals.length-2];
console.log(`session ${sid}`);
console.log(`default model: ${JSON.stringify(mo.currentValue)}`);
const set=await s.req('session/set_config_option',{sessionId:sid,configId:'model',value:target});
console.log(`set -> ${set.error?'✗ '+set.error.message:'✓ '+JSON.stringify(set.result?.configOptions.find(o=>o.id==='model')?.currentValue)}`);
s.child.stdin.end();s.child.kill();
await new Promise(r=>setTimeout(r,1200));
console.log('--- restarted process ---');
const s2=conn();
await s2.req('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false}}});
const rs=await s2.req('session/resume',{sessionId:sid,cwd:CWD});
const cur=rs.result?.configOptions?.find(o=>o.id==='model')?.currentValue;
console.log(`after resume, model: ${JSON.stringify(cur)}`);
console.log(cur===target?'=> ✓ PERSISTED ACROSS PROCESS RESTART':'=> ✗ NOT PERSISTED');
s2.child.stdin.end();s2.child.kill();process.exit(0);
