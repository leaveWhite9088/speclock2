import { spawn } from 'node:child_process';
const NODE='D:/Environment/nodejs/node.exe';
const CLI='D:/Environment/nodejs/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
const child=spawn(NODE,[CLI,'--mode','rpc','--no-session','--no-tools'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
let buf='';let text='';let id=1;
child.stdout.setEncoding('utf8');
child.stdout.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\n'))!==-1){const l=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!l)continue;
  let m;try{m=JSON.parse(l)}catch{continue}
  if(m.type==='response') console.log('RESP', m.command, m.success?'ok':'ERR '+m.error);
  if(m.type==='message_update'){const u=m.assistantMessageEvent;if(u?.type==='text_delta')text+=u.delta;}
  if(m.type==='agent_settled'){console.log('SETTLED after '+JSON.stringify(text));child.stdin.end();child.kill();process.exit(0);}
}});
child.stderr.setEncoding('utf8');child.stderr.on('data',d=>{const s=d.toString();if(/error/i.test(s))console.log('[stderr]',s.slice(0,200))});
setTimeout(()=>{child.stdin.write(JSON.stringify({id:'1',type:'prompt',message:'What is 17*23? Reply with just the number.'})+'\n');},1500);
setTimeout(()=>{console.log('TIMEOUT');child.kill();process.exit(2)},120000);
