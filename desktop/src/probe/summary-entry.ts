import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { buildP1AcceptanceSummary } from './p1-summary.js';

function parseArgs(argv: string[]) {
  let suite = 'p1-closeout';
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--suite') {
      const value = argv[++index];
      if (!value) throw new Error('--suite 需要一个值');
      suite = value;
    } else if (argument === '--help' || argument === '-h') {
      console.log('用法：npm run verify:summary -- --suite p1-closeout');
      return null;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return { suite };
}

export async function runSummaryCommand(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (!parsed) return;
  const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const result = await buildP1AcceptanceSummary({ suiteId: parsed.suite, workspaceRoot });
  console.log(`P1 汇总：${result.summary.overallStatus}；实现版本匹配：${result.summary.implementationMatches ? '是' : '否'}；P2 门：${result.summary.p2GateOpen ? '开放' : '关闭'}`);
  console.log(`JSON：${result.jsonPath}`);
  console.log(`Markdown：${result.markdownPath}`);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  runSummaryCommand().catch(error => {
    console.error(error instanceof Error ? error.message : 'verify:summary failed');
    process.exitCode = 1;
  });
}
