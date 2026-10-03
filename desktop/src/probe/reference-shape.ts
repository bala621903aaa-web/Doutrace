import type { ProbeReport, ProtobufShape } from './report.js';

function field(shape: ProtobufShape | undefined, number: number) {
  return shape?.fields.find(value => value.fieldNumber === number);
}

function matches(shape: ProtobufShape | undefined, expected: Array<[number, number]>) {
  return Boolean(shape?.parseStatus === 'parsed' && expected.every(([number, wire]) => field(shape, number)?.wireType === wire));
}

// Compare only stored structural evidence. The old report discarded all values
// and retained just the last nested shape for each repeated message field.
export function compareReferenceShape(report: ProbeReport) {
  const requests = report.observations.relevantRequests.filter(value => value.url.pathname === '/v1/message/get_by_conversation');
  const responses = report.observations.structuredResponses.filter(value => value.url.pathname === '/v1/message/get_by_conversation');
  return {
    kind: 'structural-reference-comparison',
    generatedAt: new Date().toISOString(),
    sourceReportGeneratedAt: report.generatedAt,
    p1Passed: false,
    requests: requests.map(value => {
      const query = field(field(value.protobuf, 8)?.nested, 301)?.nested;
      return {
        candidateShapeMatches: matches(query, [[1, 2], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0]]),
        fixedShortIdField3DigitCounts: [...new Set(field(query, 3)?.varintDigitCounts ?? [])],
        paginationField5DigitCounts: [...new Set(field(query, 5)?.varintDigitCounts ?? [])],
        repeatedHeaderField15Count: field(value.protobuf, 15)?.occurrences ?? 0
      };
    }),
    responses: responses.map(value => {
      const page = field(field(value.protobuf, 6)?.nested, 301)?.nested;
      const message = field(page, 1);
      return {
        candidateShapeMatches: matches(page, [[1, 2], [2, 0], [3, 0]]),
        repeatedMessageCount: message?.occurrences ?? 0,
        retainedMessageSampleMatches: matches(message?.nested, [[1, 2], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 2]]),
        indexField4DigitCounts: [...new Set(field(message?.nested, 4)?.varintDigitCounts ?? [])],
        candidateTimeField10DigitCounts: [...new Set(field(message?.nested, 10)?.varintDigitCounts ?? [])],
        candidateReferenceField18PresentInRetainedSample: Boolean(field(message?.nested, 18))
      };
    }),
    limitations: [
      '字段形状匹配只能支持候选映射，不能验证字段值、时间单位或请求成功状态。',
      '旧报告的重复消息只保留最后一项的嵌套形状，不能据此推断全部消息类型或引用样本。',
      '本命令不会联网、启动浏览器或证明连续三页、游标推进及历史终点。'
    ]
  };
}
