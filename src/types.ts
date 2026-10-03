export type MessageKind = 'text' | 'image' | 'audio' | 'unsupported';
export type EndReason = 'loaded_only' | 'history_end' | 'stalled' | 'user_stop' | 'conversation_changed' | 'page_unavailable' | 'error' | 'interrupted';
export interface MediaCandidate {
  kind: 'image' | 'audio';
  url?: string; // Private acquisition data: never exported.
  quality: 'original' | 'displayed' | 'unknown';
}
export interface CapturedMessage {
  platformId?: string;
  sender: string;
  senderId?: string;
  side: 'self' | 'other' | 'unknown';
  timestamp: string | null;
  timeText: string;
  kind: MessageKind;
  text: string;
  media: MediaCandidate[];
}
export interface Message extends Omit<CapturedMessage, 'media'> {
  ref: string;
  media: string[];
  fingerprint: string;
  capturedAt: string;
}
export interface Attachment {
  kind: 'image' | 'audio';
  quality: 'original' | 'displayed' | 'unknown';
  id: string;
  status: 'pending' | 'saved' | 'failed';
  attempts: number;
  mime?: string;
  extension?: string;
  error?: string;
  blob?: Blob;
}
export interface CaptureBatch {
  conversationKey: string;
  title: string;
  messages: CapturedMessage[]; // Oldest to newest within this observed window.
  historyEnd: boolean;
  warnings: string[];
}
export interface Run {
  id: string;
  startedAt: string;
  finishedAt?: string;
  reason?: EndReason;
  mode: 'loaded' | 'history';
  batches: number;
  added: number;
}
export interface Conversation {
  key: string;
  title: string;
  messages: Message[];
  runs: Run[];
  warnings: string[];
  updatedAt: string;
}
export interface StoredArchive { conversation: Conversation; attachments: Attachment[] }
export const endLabels: Record<EndReason, string> = {
  loaded_only: '当前已加载消息已保存', history_end: '页面明确显示已到达历史终点',
  stalled: '历史加载停滞，不能确认已到终点', user_stop: '用户停止',
  conversation_changed: '会话变化，已停止采集', page_unavailable: '原页面不可用',
  error: '采集错误', interrupted: '任务中断，已保存数据仍可导出'
};
