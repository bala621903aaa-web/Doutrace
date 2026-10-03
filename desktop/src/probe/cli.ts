import { type BrowserContext, type Page } from 'playwright-core';
import { appDataRoot } from './browser.js';
import { createHistoryProtocolObserver, type HistoryProtocolEvidence } from './im-protocol.js';
import { redactUrl, saveProbeReport, summarizeJson, summarizeProtobuf, type PageSnapshot, type ProbeReport, type RequestObservation, type ResponseObservation, type SdkObjectObservation } from './report.js';
import { startBrowserProbeSession, TARGET_CHAT_URL, waitForEnter } from './session.js';
const SAFE_HOSTS = ['douyin.com', 'douyinvod.com', 'douyinpic.com', 'iesdouyin.com'];

function isSafeObservedHost(raw: string) {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return SAFE_HOSTS.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function candidateGlobals(page: Page) {
  return page.evaluate(() => Object.keys(window)
    .filter(key => /chat|message|history|conversation|im|sdk|proto|websocket/i.test(key))
    .sort()
    .slice(0, 160));
}

async function inspectSdkObjects(page: Page): Promise<SdkObjectObservation[]> {
  const names = await candidateGlobals(page);
  const inventoryScript = String.raw`((candidates) => {
    function describe(name, value) {
      if (value === undefined) return { name, type: 'missing' };
      if (typeof value === 'function') {
        const source = Function.prototype.toString.call(value);
        const referencedEndpoints = Array.from(new Set(source.match(/\/v[123](?:\/|%2F)[A-Za-z0-9_./-]{2,100}/g) || [])).slice(0, 20);
        return { name, type: 'function', functionArity: value.length, referencedEndpoints };
      }
      if (!value || typeof value !== 'object') return { name, type: 'other' };
      const keys = Object.keys(value).sort().slice(0, 120);
      const nestedKeyTypes = {};
      for (const key of keys.slice(0, 40)) {
        try { nestedKeyTypes[key] = typeof value[key]; } catch { nestedKeyTypes[key] = 'unreadable'; }
      }
      return { name, type: 'object', ownKeys: keys, nestedKeyTypes };
    }
    const result = candidates
      .filter(name => /conversationStore|openImConversation|@pc-im|SDKNativeWebApi|SDKRuntime|im:/i.test(name))
      .map(name => {
        const descriptor = Object.getOwnPropertyDescriptor(window, name);
        if (!descriptor) return { name, type: 'missing' };
        if (!('value' in descriptor)) return { name, type: 'accessor' };
        return describe(name, descriptor.value);
      });
    const store = window.conversationStore;
    if (store) {
      const conversationMap = store.conversationMap;
      const currentId = typeof store.curConversationId === 'string' ? store.curConversationId : '';
      const current = conversationMap && typeof conversationMap === 'object' && currentId ? conversationMap[currentId] : undefined;
      const storeSummary = describe('conversationStore', store);
      if (conversationMap && typeof conversationMap === 'object') storeSummary.collectionCounts = { conversationMap: Object.keys(conversationMap).length };
      result.push(storeSummary);
      result.push(describe('conversationStore.currentConversation', current));
      if (current && typeof current === 'object') {
        const collectionCounts = {};
        for (const key of Object.keys(current)) {
          const value = current[key];
          if (Array.isArray(value)) collectionCounts[key] = value.length;
          else if (value && typeof value === 'object') {
            try { collectionCounts[key] = Object.keys(value).length; } catch { /* ignore unreadable state */ }
          }
        }
        result[result.length - 1].collectionCounts = collectionCounts;
      }
      for (const key of ['loadMoreConversations', 'fetchParticipants', 'setCurConversation', 'getOneParticipant']) {
        if (key in store) result.push(describe('conversationStore.' + key, store[key]));
      }
    }
    return result;
  })(${JSON.stringify(names)})`;
  return page.evaluate(inventoryScript) as Promise<SdkObjectObservation[]>;
}

async function snapshot(page: Page): Promise<PageSnapshot> {
  const values = await page.evaluate(() => {
    const rows = document.querySelectorAll('.messageMessageBoxmessageBox').length;
    const areas = [...document.querySelectorAll<HTMLElement>('*')]
      .filter(element => element.scrollHeight > element.clientHeight + 80 && getComputedStyle(element).overflowY !== 'visible')
      .slice(0, 20)
      .map(element => ({ selector: element.className ? `.${String(element.className).split(/\s+/)[0]}` : element.tagName.toLowerCase(), top: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight }));
    return { origin: location.origin, pathname: location.pathname, rows, areas };
  });
  return {
    capturedAt: new Date().toISOString(),
    origin: values.origin,
    pathname: values.pathname,
    messageRowCount: values.rows,
    scrollAreaCount: values.areas.length,
    scrollPositions: values.areas,
    sdkGlobalCandidates: await candidateGlobals(page)
  };
}

function addResponseObserver(context: BrowserContext, page: Page, requests: RequestObservation[], responses: ResponseObservation[], counters: { requests: number; responses: number }, websocketUrls: Set<string>, historyProtocol: Array<{ observedAt: string; evidence: HistoryProtocolEvidence }>) {
  const summarizeHistory = createHistoryProtocolObserver();
  const pending = new Set<Promise<void>>();
  let closed = false;
  context.on('request', request => {
    if (isSafeObservedHost(request.url())) counters.requests++;
    if (!isSafeObservedHost(request.url()) || requests.length >= 160) return;
    const contentType = request.headers()['content-type'] || '';
    if (!/protobuf|octet-stream|application\/grpc|\/v1\/message\/|\/v[123]\/conversation\//i.test(`${contentType} ${request.url()}`)) return;
    void (async () => {
      const observation: RequestObservation = {
        observedAt: new Date().toISOString(),
        method: request.method(),
        url: redactUrl(request.url()),
        resourceType: request.resourceType(),
        contentType,
        bodyKind: 'empty'
      };
      try {
        const body = request.postDataBuffer();
        if (!body?.length) { requests.push(observation); return; }
        observation.bodyBytes = body.length;
        if (/protobuf|octet-stream|application\/grpc/i.test(contentType) || /\/v1\/message\/|\/v[123]\/conversation\//i.test(request.url())) {
          observation.bodyKind = 'protobuf-or-binary';
          observation.protobuf = summarizeProtobuf(body);
        } else {
          observation.bodyKind = 'text';
        }
      } catch {
        observation.bodyKind = 'unreadable';
      }
      requests.push(observation);
    })();
  });
  page.on('websocket', websocket => {
    if (isSafeObservedHost(websocket.url()) && websocketUrls.size < 40) websocketUrls.add(JSON.stringify(redactUrl(websocket.url())));
  });
  context.on('response', response => {
    if (closed || !isSafeObservedHost(response.url()) || responses.length + pending.size >= 160) return;
    const task = (async () => {
      const headers = response.headers();
      const contentType = headers['content-type'] || '';
      const observation: ResponseObservation = {
        observedAt: new Date().toISOString(),
        method: response.request().method(),
        url: redactUrl(response.url()),
        resourceType: response.request().resourceType(),
        status: response.status(),
        contentType,
        bodyKind: 'not-read'
      };
      counters.responses++;
      if (/(json|javascript)/i.test(contentType)) {
        const length = Number(headers['content-length']);
        if (Number.isFinite(length) && length > 4 * 1024 * 1024) {
          observation.bodyKind = 'unreadable';
        } else {
          try {
            const body = await response.text();
            observation.bodyBytes = Buffer.byteLength(body);
            observation.bodyKind = 'json';
            try { observation.shape = summarizeJson(JSON.parse(body)); }
            catch { observation.bodyKind = 'text'; }
          } catch {
            observation.bodyKind = 'unreadable';
          }
        }
      } else if (/protobuf|octet-stream|application\/grpc/i.test(contentType)) {
        observation.bodyKind = 'protobuf-or-binary';
        try {
          const body = await response.body();
          observation.bodyBytes = body.length;
          observation.protobuf = summarizeProtobuf(body);
          if (!closed && observation.url.pathname === '/v1/message/get_by_conversation' && observation.method === 'POST') {
            historyProtocol.push({
              observedAt: observation.observedAt,
              evidence: summarizeHistory(response.request().postDataBuffer() ?? new Uint8Array(), body)
            });
          }
        } catch {
          observation.bodyKind = 'unreadable';
        }
      }
      if (!closed) responses.push(observation);
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => undefined);
  });
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      closed = true;
    }
    return pending.size;
  };
}

export async function runProbe() {
  const session = await startBrowserProbeSession();
  const { context, page, executable } = session;
  const responses: ResponseObservation[] = [];
  const counters = { requests: 0, responses: 0 };
  const websocketUrls = new Set<string>();
  const requests: RequestObservation[] = [];
  const historyProtocol: Array<{ observedAt: string; evidence: HistoryProtocolEvidence }> = [];
  const finishObservations = addResponseObserver(context, page, requests, responses, counters, websocketUrls, historyProtocol);
  await page.goto(TARGET_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(error => {
    console.warn(`打开抖音页面未完成：${error instanceof Error ? error.message : String(error)}`);
  });
  const initial = await snapshot(page).catch(() => ({ capturedAt: new Date().toISOString(), origin: '', pathname: '', messageRowCount: 0, scrollAreaCount: 0, scrollPositions: [], sdkGlobalCandidates: [] }));
  console.log(`已启动独立 ${executable.kind} 配置，配置目录：${appDataRoot()}`);
  console.log('请在打开的官方抖音页面中自行登录，并打开本次验证指定的单人私聊。不要滚动消息列表，也不要发送任何内容。');
  await waitForEnter('目标私聊已稳定显示后，在此终端按 Enter 开始记录当前状态。');
  const selected = await snapshot(page);
  const sdkObjects = await inspectSdkObjects(page);
  await page.waitForTimeout(2_000);
  await Promise.all(context.pages().map(candidate => candidate.waitForTimeout(200).catch(() => undefined)));
  const pendingResponseCount = await finishObservations();
  const report: ProbeReport = {
    reportVersion: 2,
    generatedAt: new Date().toISOString(),
    browser: { kind: executable.kind, executablePath: executable.path },
    target: { origin: selected.origin, pathname: selected.pathname },
    observations: {
      initial,
      selected,
      sdkGlobalCandidates: [...new Set([...initial.sdkGlobalCandidates, ...selected.sdkGlobalCandidates])],
      sdkObjects,
      requestCount: counters.requests,
      responseCount: counters.responses,
      pendingResponseCount,
      relevantRequests: requests,
      structuredResponses: responses,
      websocketUrls: [...websocketUrls].map(value => JSON.parse(value)),
      historyProtocol
    },
    privacy: {
      note: '报告仅保存协议结构和脱敏网络元数据，用于适配调查；不会保存聊天正文、认证头、Cookie、请求参数值或原始网络响应。',
      omitted: ['聊天正文和媒体', 'Cookie、Token、认证头', 'URL 查询参数值', '原始 JSON/Protobuf 响应', '附件签名地址']
    }
  };
  const reportPath = await saveProbeReport(report);
  console.log(`P1 初步观察报告已保存：${reportPath}`);
  console.log(`观察到 ${counters.requests} 个抖音域请求、${counters.responses} 个响应；报告不会据此宣称历史分页已通过。`);
  console.log(`候选协议解码：${historyProtocol.filter(value => value.evidence.state === 'decoded').length} 个会话历史交换；所有结果仍标记 P1 未通过。`);
  await session.close();
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  runProbe().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
