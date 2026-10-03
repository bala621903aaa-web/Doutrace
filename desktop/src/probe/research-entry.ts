import { readFile, writeFile } from 'node:fs/promises';
import type { ProbeReport } from './report.js';
import { compareReferenceShape } from './reference-shape.js';

const path = process.argv[2];
if (!path) {
  console.error('用法：npm --prefix desktop run research:check -- <脱敏探针报告.json> [对照输出.json]');
  process.exitCode = 1;
} else {
  try {
    const report = JSON.parse(await readFile(path, 'utf8')) as ProbeReport;
    const result = JSON.stringify(compareReferenceShape(report), null, 2);
    if (process.argv[3]) await writeFile(process.argv[3], `${result}\n`, 'utf8');
    console.log(result);
  } catch {
    console.error('无法读取或对照探针报告；请提供原探针生成的脱敏 JSON。');
    process.exitCode = 1;
  }
}
