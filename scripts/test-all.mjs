#!/usr/bin/env node
// 一键跑全部项目测试：房间 / 大平层 / 菜园 / 项目级契约
import { spawnSync } from 'node:child_process';

const suites = [
  ['房间状态', 'test:room'],
  ['大平层状态', 'test:home'],
  ['菜园', 'test:garden'],
  ['项目自检', 'test:project']
];

const results = [];
for (const [name, script] of suites) {
  const started = Date.now();
  const r = spawnSync('npm', ['run', '--silent', script], { shell: true, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ok = r.status === 0;
  results.push({ name, script, ok, ms: Date.now() - started });
  const line = out.split('\n').filter((l) => /通过|passed|未通过|FAIL/.test(l)).slice(-3).join(' | ');
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(8)} ${String(Date.now() - started).padStart(6)}ms  ${line}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n汇总：${results.length - failed.length}/${results.length} 组通过`);
if (failed.length) process.exit(1);
