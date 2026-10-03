import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readDouyinChat } from '../src/douyin-dom';

describe('verified Douyin chat DOM adapter', () => {
  it('uses visible chat title, direction markers, time labels, and image nodes', () => {
    const dom = new JSDOM(`<!doctype html><div class="RightPanelHeaderinfoContainer"><div>好友甲</div></div>
    <div class="messageMessageListlist">
      <div class="messageMessageBoxmessageBox"><div class="messageMessageBoxcontentBox messageMessageBoxisFromMe"><span class="TextMessageTextpureText">新消息</span></div></div>
      <div class="messageMessageBoxmessageBox"><div class="MessageBoxTimetimeLayout">昨天 21:53</div><div class="messageMessageBoxcontentBox"><span class="TextMessageTextpureText">旧消息</span></div></div>
      <div class="messageMessageBoxmessageBox"><div class="messageMessageBoxcontentBox"><div class="MessageItemImageImageBox"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="></div></div></div>
    </div>`, { url: 'https://www.douyin.com/chat?isPopup=1' });
    const batch = readDouyinChat(dom.window.document, dom.window.location.href);
    expect(batch.title).toBe('好友甲');
    expect(batch.messages.map(m => [m.kind, m.side])).toEqual([['image', 'other'], ['text', 'other'], ['text', 'self']]);
    expect(batch.messages[1].timeText).toBe('昨天 21:53');
    expect(batch.messages[0].media[0].url).toContain('data:image/png;base64');
  });
  it('rejects unrelated pages and does not infer the history end from chat text', () => {
    const dom = new JSDOM('<body>用户说：没有更多消息</body>', { url: 'https://www.douyin.com/' });
    expect(() => readDouyinChat(dom.window.document, dom.window.location.href)).toThrow('私聊页面');
  });
});
