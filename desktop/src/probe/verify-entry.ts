import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { HistoryNetworkObserver } from './history-transport.js';
import { runHistoryVerification } from './history-verifier.js';
import { readPageState } from './page-state.js';
import { installStopSignals, startBrowserProbeSession, TARGET_CHAT_URL, waitForEnter } from './session.js';

function parseArgs(argv: string[]) {
  let task: 'chain' | 'time' | 'endpoint' | 'recovery' | 'semantics' = 'chain';
  let suite = 'p1-closeout';
  let pages = 3;
  let maxPages: number | undefined;
  let snapshots = 3;
  let uiMessageInfo = false;
  let mainSequence = false;
  let checkpoint: string | undefined;
  let prepare = false;
  let resume = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--task') {
      const value = argv[++index] as 'chain' | 'time' | 'endpoint' | 'recovery' | 'semantics' | undefined;
      if (!value || !['chain', 'time', 'endpoint', 'recovery', 'semantics'].includes(value)) throw new Error('--task 必须是 chain、time、endpoint、recovery 或 semantics');
      task = value;
    } else if (argument === '--main-sequence') {
      mainSequence = true;
    } else if (argument === '--ui-message-info') {
      uiMessageInfo = true;
    } else if (argument === '--suite') {
      suite = argv[++index] || '';
      if (!suite) throw new Error('--suite 需要一个值');
    } else if (argument === '--checkpoint') {
      checkpoint = argv[++index] || '';
      if (!checkpoint) throw new Error('--checkpoint 需要一个值');
    } else if (argument === '--prepare') {
      prepare = true;
    } else if (argument === '--resume') {
      resume = true;
    } else if (argument === '--pages') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 50) throw new Error('--pages 必须是 1 到 50 的整数');
      pages = value;
    } else if (argument === '--snapshots') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error('--snapshots 必须是 1 到 5 的整数');
      snapshots = value;
    } else if (argument === '--max-pages') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 50) throw new Error('--max-pages 必须是 1 到 50 的整数');
      maxPages = value;
    } else if (argument === '--help' || argument === '-h') {
      console.log('用法：npm run verify:history -- --suite p1-closeout --task chain --pages 3');
      console.log('任务：chain（默认三页）、time --snapshots 3（当前渲染窗口，不主动翻页）、endpoint --max-pages 5、recovery --prepare/--resume --checkpoint main-boundary、semantics --max-pages 20');
      process.exitCode = 0;
      return null;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  if (resume && task !== 'recovery') throw new Error('--resume 只能与 --task recovery 一起使用');
  if (prepare && task !== 'recovery') throw new Error('--prepare 只能与 --task recovery 一起使用');
  if (prepare && resume) throw new Error('--prepare 与 --resume 不能同时使用');
  if (task === 'chain' && pages < 3) throw new Error('chain 任务至少需要 --pages 3；短会话请使用 endpoint');
  if (task === 'recovery' && !checkpoint) throw new Error('recovery 任务必须指定 --checkpoint <id>');
  if (task === 'recovery' && !resume) prepare = true;
  if (task === 'time' && maxPages !== undefined) throw new Error('time 不读取历史分页，请使用 --snapshots 控制当前窗口采样次数');
  if (uiMessageInfo && task !== 'time') throw new Error('--ui-message-info 仅用于 time');
  if (mainSequence && (task !== 'time' || snapshots !== 1 || !uiMessageInfo || !checkpoint || resume || prepare)) throw new Error('--main-sequence 需要 --task time --snapshots 1 --ui-message-info --checkpoint <id>，不与恢复标志组合');
  return { task, suite, pages, maxPages, snapshots, uiMessageInfo, mainSequence, checkpoint, prepare, resume };
}

export async function runHistoryVerificationCommand(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (!parsed) return;
  const controller = new AbortController();
  const removeSignals = installStopSignals(controller);
  let session: Awaited<ReturnType<typeof startBrowserProbeSession>> | undefined;
  let observer: HistoryNetworkObserver | undefined;
  try {
    session = await startBrowserProbeSession(() => controller.abort());
    observer = new HistoryNetworkObserver(session.context);
    await session.page.goto(TARGET_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
    console.log(`已启动独立 ${session.executable.kind} 配置。验证器只使用该配置，不复制日常浏览器数据。`);
    const requirement = parsed.task === 'endpoint' ? '选择同账号另一条既有短单人私聊，允许不足三页' : parsed.task === 'recovery' ? '选择与检查点相同的既有单人私聊' : parsed.task === 'semantics' ? '选择包含本版已存在多种消息类型的既有单人私聊' : parsed.task === 'time' ? parsed.uiMessageInfo ? '选择当前正常加载窗口至少有十条消息的既有单人私聊' : '选择当前已加载窗口含有完整日期/相对日期和时分的既有单人私聊' : '选择历史足以返回目标页数的既有单人私聊';
    console.log(`请在打开的官方抖音页面中正常登录，${requirement}。不要滚动消息列表、不要发送消息。`);
    console.log(parsed.resume ? '本次为恢复验证：程序会读取 suite 私有检查点和控制页基准，核对实际恢复请求、响应及下一次续传。' : parsed.task === 'recovery' ? '本次为恢复准备：读取两页后保存独立检查点，再以同游标读取控制页；请在本进程退出后再执行 --resume。' : parsed.task === 'time' ? '本次只对照页面正常初始化/加载的响应和当前渲染消息；必要时提示追加其他已有会话窗口。' : '首屏交换作为校准页；之后由验证器主动发起有界的只读历史续传。');
    if (parsed.uiMessageInfo) console.log('本次还触发官方行内“复制消息信息”功能；信息仅在内存核对，结束时恢复原剪贴板文本，不保存复制正文。');
    if (parsed.mainSequence) console.log('本次在同一正常浏览器会话中依次完成 time、semantics、chain、recovery prepare；各自生成独立真实报告，共用本进程页面正常加载的首屏交换。遇到缺口即停止，不自动切换会话。');
    if (!await waitForEnter('账号和目标会话稳定显示后，在此终端按 Enter 开始真实验证。', controller.signal)) return;
    const state = await readPageState(session.page).catch(() => null);
    if (state && !state.messageList.found) console.log('提示：当前页面未找到目标消息列表，验证报告会如实记为未完成，不会切换到滚动采集。');
    const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const options = { session, observer, task: parsed.task, suiteId: parsed.suite, checkpointId: parsed.checkpoint, prepare: parsed.prepare, pages: parsed.pages, maxPages: parsed.maxPages, timeSnapshots: parsed.snapshots, uiMessageInfo: parsed.uiMessageInfo, resume: parsed.resume, workspaceRoot, signal: controller.signal };
    if (!parsed.mainSequence) await runHistoryVerification(options);
    else {
      await observer.drainPendingResponses();
      const baseline = state && state.selectedConversationIds.length === 1 ? observer.listHistoryExchanges()
        .filter(exchange => exchange.request.decoded.conversationId === state.selectedConversationIds[0] && exchange.decoded?.state === 'decoded')
        .at(-1) : undefined;
      if (!baseline) throw new Error('sequence-normal-initial-exchange-not-captured');
      for (const task of ['time', 'semantics', 'chain', 'recovery'] as const) {
        if (controller.signal.aborted) break;
        const result = await runHistoryVerification({ ...options, task, prepare: task === 'recovery', resume: false, uiMessageInfo: task === 'time', initialExchange: baseline });
        const prepared = task === 'recovery' && result.report.errors.length === 0 && result.report.resume.checkpointSaved && result.report.resume.controlMatches === true;
        if (result.report.verdict !== 'pass' && !prepared) { console.log(`同窗口复检在 ${task} 停止，保留真实缺口。`); break; }
      }
    }
  } finally {
    if (observer) await observer.close().catch(() => undefined);
    if (session) await session.close().catch(() => undefined);
    removeSignals();
  }
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  runHistoryVerificationCommand().catch(error => {
    console.error(error instanceof Error ? error.message : 'verify:history failed');
    process.exitCode = 1;
  });
}
