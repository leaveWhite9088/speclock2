/**
 * The rules texts agentd hands to its agents are what they should be: loaded, free of editor comments, and the
 * executor's covers its scope, its limits, the commands that never end, and how to report.
 */

import { dispatcherRules, executorRules } from '../core/rules.mjs';
import { check } from './lib/scheduler.mjs';

console.log('\n=== the rules texts ===\n');

const e = executorRules();
const d = dispatcherRules();
check('the executor rules are there and have no editor comments', e.length > 300 && !e.includes('<!--'));
check('they cover scope, limits and reporting', ['## 范围', '## 约束', '## 回报'].every((h) => e.includes(h)));
check('they say not to run a command that never exits in the foreground', e.includes('## 不会自己结束的命令') && /npm run dev/.test(e) && /放到后台运行/.test(e));
check('they say how to put it in the background, and how to leave it to the user', /Start-Process/.test(e) && /nohup/.test(e) && /用户自己/.test(e));
check('the dispatcher rules are there too, and say a failure goes to the person', d.length > 300 && /等用户决定/.test(d));
check('the dispatcher is not told the executor-only rules', !d.includes('## 不会自己结束的命令'));

console.log(process.exitCode ? '\n=> ✗ RULES BROKEN' : '\n=> ✓ RULES OK');
process.exit(process.exitCode ?? 0);
