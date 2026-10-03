import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  hashSuiteCode,
  P1_REQUIREMENTS,
  readVerificationSuiteManifest,
  PROTOCOL_MAPPING_VERSION,
  sha256Path,
  TASK_REQUIREMENTS,
  TIME_MAPPING_VERSION,
  type P1RequirementKey,
  type SuiteManifestRun,
  type VerificationSuiteManifest
} from './verification-suite.js';

export type AcceptanceStatus = 'pass' | 'fail' | 'inconclusive' | 'not-run';

export interface AcceptanceItem {
  key: P1RequirementKey;
  status: AcceptanceStatus;
  evidenceSources: Array<{
    task: string;
    runId: string;
    reportPath: string;
    reportSha256: string;
    reportStatus: string;
    codeVersionHash: string;
    protocolMappingVersion: string;
    timeMappingVersion: string;
  }>;
  applicableTasks: string[];
  gaps: string[];
}

export interface P1AcceptanceSummary {
  summaryVersion: 1;
  kind: 'p1-acceptance-summary';
  generatedAt: string;
  suiteId: string;
  overallStatus: AcceptanceStatus;
  implementationMatches: boolean;
  p2GateOpen: boolean;
  requiredRequirements: typeof P1_REQUIREMENTS;
  items: AcceptanceItem[];
  ignoredEvidence: Array<{ reportPath: string; reason: string }>;
  privacy: {
    note: string;
    omitted: string[];
  };
}

interface TaskReport {
  reportVersion?: number;
  kind?: string;
  task?: string;
  runId?: string;
  verdict?: string;
  evidenceComplete?: boolean;
  accountFingerprints?: string[];
  resume?: { requested?: boolean };
  suite?: {
    suiteId?: string;
    runId?: string;
    task?: string;
    codeVersion?: { files?: Record<string, string> };
    protocolMappingVersion?: string;
    timeMappingVersion?: string;
  } | null;
  requirements?: Array<{ key?: string; status?: string; evidence?: Record<string, unknown>; gaps?: string[] }>;
  errors?: Array<{ code?: string; phase?: string }>;
}

function codeVersionHash(run: SuiteManifestRun) {
  return Object.entries(run.codeVersion.files).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}:${value}`).join('|');
}

function currentCodeVersionHash(files: Record<string, string>) {
  return Object.entries(files).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}:${value}`).join('|');
}

function implementationCodeVersionHash(files: Record<string, string>) {
  // The acceptance aggregator is not part of the verifier that produced the
  // evidence. Keep summary-only fixes from invalidating already captured runs.
  const evidenceFiles = Object.fromEntries(Object.entries(files).filter(([key]) => key !== 'src/probe/p1-summary.ts'));
  return currentCodeVersionHash(evidenceFiles);
}

async function readTaskReport(run: SuiteManifestRun, suiteId: string) {
  try {
    const actualHash = await sha256Path(run.reportJsonPath);
    if (actualHash !== run.reportJsonSha256) return { report: null, reason: '报告文件散列与 suite 清单不一致。' };
    const report = JSON.parse(await readFile(run.reportJsonPath, 'utf8')) as TaskReport;
    if (report.reportVersion !== 2 || report.kind !== 'p1-live-verification') return { report: null, reason: '旧格式或非 P1 分项报告，不能升级为真实证据。' };
    if (!report.suite || report.suite.suiteId !== suiteId || report.suite.runId !== run.runId || report.suite.task !== run.task) return { report: null, reason: '报告与 suite 运行身份不匹配。' };
    if (JSON.stringify(report.suite.codeVersion?.files ?? {}) !== JSON.stringify(run.codeVersion.files) || report.suite.protocolMappingVersion !== run.protocolMappingVersion || report.suite.timeMappingVersion !== run.timeMappingVersion) return { report: null, reason: '报告中的代码/协议/时间映射版本与清单不一致。' };
    if (report.evidenceComplete !== true) return { report: null, reason: '报告没有完整的 suite 证据元数据。' };
    return { report, reason: null };
  } catch {
    return { report: null, reason: '报告文件缺失或不可解析。' };
  }
}

function reportRequirement(report: TaskReport, key: P1RequirementKey) {
  return report.requirements?.find(item => item.key === key) ?? null;
}

function isFinalTaskEvidence(report: TaskReport, key: P1RequirementKey) {
  // recovery --prepare intentionally emits an inconclusive boundary report.
  // It is a prerequisite for the later --resume report, not a competing final
  // verdict for cursor-recovery.
  return key !== 'cursor-recovery' || report.resume?.requested === true;
}

export async function buildP1AcceptanceSummary(input: { suiteId: string; workspaceRoot: string }): Promise<{ summary: P1AcceptanceSummary; jsonPath: string; markdownPath: string }> {
  const currentFiles = await hashSuiteCode(input.workspaceRoot);
  const manifest = await readVerificationSuiteManifest(input.suiteId);
  const ignoredEvidence: Array<{ reportPath: string; reason: string }> = [];
  const usable: Array<{ run: SuiteManifestRun; report: TaskReport }> = [];
  if (manifest) {
    for (const run of manifest.runs) {
      const loaded = await readTaskReport(run, manifest.suiteId);
      if (loaded.report && (implementationCodeVersionHash(run.codeVersion.files) !== implementationCodeVersionHash(currentFiles) ||
          run.protocolMappingVersion !== PROTOCOL_MAPPING_VERSION || run.timeMappingVersion !== TIME_MAPPING_VERSION)) {
        ignoredEvidence.push({ reportPath: run.reportJsonPath, reason: '实现或映射版本已失效；保留历史报告，当前门槛仅采用最终实现的真实复验。' });
      } else if (loaded.report) usable.push({ run, report: loaded.report });
      else ignoredEvidence.push({ reportPath: run.reportJsonPath, reason: loaded.reason ?? '未通过报告完整性检查。' });
    }
  }
  const allPassSources: Array<{ run: SuiteManifestRun; report: TaskReport }> = [];
  const items: AcceptanceItem[] = P1_REQUIREMENTS.map(key => {
    const tasks = Object.entries(TASK_REQUIREMENTS).filter(([, keys]) => keys.includes(key)).map(([task]) => task);
    const candidates = usable.filter(item => tasks.includes(item.run.task) && reportRequirement(item.report, key) && isFinalTaskEvidence(item.report, key));
    const statuses = candidates.map(item => reportRequirement(item.report, key)!.status).filter((status): status is string => Boolean(status));
    const status: AcceptanceStatus = !candidates.length
      ? 'not-run'
      : statuses.includes('fail')
        ? 'fail'
        : statuses.includes('pass')
          ? 'pass'
          : statuses.includes('inconclusive') || statuses.includes('not-run')
            ? 'inconclusive'
            : 'inconclusive';
    const gaps: string[] = [];
    if (!manifest) gaps.push('未找到本机 suite 清单。');
    if (!candidates.length) gaps.push(`尚无任务 ${tasks.join(' / ')} 的完整真实报告。`);
    if (statuses.includes('fail')) gaps.push('至少一个适用真实报告明确失败；不能由另一份 pass 掩盖。');
    if (!statuses.includes('pass') && (statuses.includes('inconclusive') || statuses.includes('not-run'))) gaps.push('存在未决或未执行证据，尚不能按 pass 汇总；后续完整 pass 可替代本次证据不足的尝试。');
    const evidenceSources = candidates.map(({ run, report }) => {
      const item = reportRequirement(report, key)!;
      if (item.status === 'pass') allPassSources.push({ run, report });
      return { task: run.task, runId: run.runId, reportPath: run.reportJsonPath, reportSha256: run.reportJsonSha256, reportStatus: item.status ?? 'unknown', codeVersionHash: codeVersionHash(run), protocolMappingVersion: run.protocolMappingVersion, timeMappingVersion: run.timeMappingVersion };
    });
    return { key, status, evidenceSources, applicableTasks: tasks, gaps };
  });
  const overallStatus: AcceptanceStatus = items.some(item => item.status === 'fail') ? 'fail' : items.some(item => item.status !== 'pass') ? 'inconclusive' : 'pass';
  const accounts = new Set(allPassSources.flatMap(({ report }) => report.accountFingerprints ?? []));
  const accountMatches = allPassSources.length > 0 && accounts.size === 1 && allPassSources.every(({ report }) => report.accountFingerprints?.length === 1);
  const implementationMatches = Boolean(manifest) && items.every(item => item.status === 'pass') && accountMatches &&
    Object.values(currentFiles).every(value => /^[a-f0-9]{64}$/.test(value)) &&
    allPassSources.every(({ run }) => implementationCodeVersionHash(run.codeVersion.files) === implementationCodeVersionHash(currentFiles) && run.protocolMappingVersion === PROTOCOL_MAPPING_VERSION && run.timeMappingVersion === TIME_MAPPING_VERSION);
  if (allPassSources.length && !accountMatches) {
    ignoredEvidence.push({ reportPath: 'suite-account-association', reason: '通过报告缺少同一账号的 suite 匿名关联，或混入不同账号；P2 门保持关闭。' });
  }
  const summary: P1AcceptanceSummary = {
    summaryVersion: 1,
    kind: 'p1-acceptance-summary',
    generatedAt: new Date().toISOString(),
    suiteId: manifest?.suiteId ?? input.suiteId,
    overallStatus,
    implementationMatches,
    p2GateOpen: overallStatus === 'pass' && implementationMatches,
    requiredRequirements: P1_REQUIREMENTS,
    items,
    ignoredEvidence,
    privacy: {
      note: '汇总只引用不可变分项报告的散列、任务、版本和脱敏判定，不保存原始消息、账号、会话、游标或认证材料。',
      omitted: ['聊天正文和媒体 URL', '原始账号/会话/消息 ID', '认证材料', 'suite 私有 HMAC 密钥']
    }
  };
  const jsonPath = join(input.workspaceRoot, 'P1-ACCEPTANCE-SUMMARY.json');
  const markdownPath = join(input.workspaceRoot, 'P1-ACCEPTANCE-SUMMARY.md');
  await writeFile(jsonPath, JSON.stringify(summary, null, 2), 'utf8');
  await writeFile(markdownPath, renderSummaryMarkdown(summary), 'utf8');
  return { summary, jsonPath, markdownPath };
}

function renderSummaryMarkdown(summary: P1AcceptanceSummary) {
  return [
    '# P1 Acceptance Summary',
    '',
    `生成时间：${summary.generatedAt}（Asia/Shanghai）`,
    `suite：\`${summary.suiteId}\`；总判定：**${summary.overallStatus}**；实现版本匹配：**${summary.implementationMatches ? '是' : '否'}**；P2 门：**${summary.p2GateOpen ? '开放' : '关闭'}**。`,
    '',
    '只有八项必验条件全部由本 suite 的完整真实分项报告判为 pass，且报告代码/协议/时间映射散列与当前实现一致时，才允许继续 P2～P5。合成测试和 legacy 报告不计入真实证据。',
    '',
    '| P1 必验项 | 判定 | 适用任务 | 有效证据 | 缺口 |',
    '|---|---|---|---|---|',
    ...summary.items.map(item => `| ${item.key} | ${item.status} | ${item.applicableTasks.join(' / ')} | ${item.evidenceSources.map(source => `${source.task}:${source.runId}`).join('<br>') || '无'} | ${item.gaps.join(' ') || '无'} |`),
    '',
    '## 被忽略的证据',
    '',
    ...(summary.ignoredEvidence.length ? summary.ignoredEvidence.map(item => `- ${item.reportPath}：${item.reason}`) : ['- 无。']),
    '',
    '## 隐私边界',
    '',
    ...summary.privacy.omitted.map(item => `- 未保存：${item}。`),
    ''
  ].join('\n');
}
