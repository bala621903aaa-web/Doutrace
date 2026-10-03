import { openDB, type DBSchema } from 'idb';
import type { Attachment, Conversation, StoredArchive } from './types';
interface ArchiveDB extends DBSchema {
  conversations: { key: string; value: Conversation };
  attachments: { key: string; value: Attachment & { conversationKey: string }; indexes: { conversationKey: string } };
}
export class ArchiveStore {
  private db;
  constructor(name = 'douyin-chat-archive-v1') {
    this.db = openDB<ArchiveDB>(name, 1, { upgrade(db) {
      db.createObjectStore('conversations', { keyPath: 'key' });
      db.createObjectStore('attachments', { keyPath: 'id' }).createIndex('conversationKey', 'conversationKey');
    }});
  }
  async list() { return (await this.db).getAll('conversations'); }
  async load(key: string): Promise<StoredArchive | undefined> {
    const db = await this.db;
    const tx = db.transaction(['conversations', 'attachments']);
    const conversation = await tx.objectStore('conversations').get(key);
    if (!conversation) return;
    const attachments = await tx.objectStore('attachments').index('conversationKey').getAll(key);
    await tx.done;
    return { conversation, attachments };
  }
  async save(conversation: Conversation, attachments: (Attachment & { sourceUrl?: string })[] = []) {
    const db = await this.db;
    const tx = db.transaction(['conversations', 'attachments'], 'readwrite');
    await tx.objectStore('conversations').put(conversation);
    for (const a of attachments) {
      const prev = await tx.objectStore('attachments').get(a.id);
      const { sourceUrl: _sourceUrl, ...persisted } = a;
      const value = prev?.status === 'saved' ? prev : { ...prev, ...persisted };
      await tx.objectStore('attachments').put({ ...value, conversationKey: conversation.key });
    }
    await tx.done;
  }
  async putAttachment(key: string, a: Attachment) {
    const db = await this.db;
    const tx = db.transaction(['conversations', 'attachments'], 'readwrite');
    if (await tx.objectStore('conversations').get(key)) await tx.objectStore('attachments').put({ ...a, conversationKey: key });
    await tx.done;
  }
  async remove(key: string) {
    const db = await this.db;
    const tx = db.transaction(['conversations', 'attachments'], 'readwrite');
    const ids = await tx.objectStore('attachments').index('conversationKey').getAllKeys(key);
    for (const id of ids) await tx.objectStore('attachments').delete(id);
    await tx.objectStore('conversations').delete(key);
    await tx.done;
  }
  async recover() {
    for (const c of await this.list()) {
      let changed = false;
      for (const run of c.runs) if (!run.finishedAt) {
        run.finishedAt = new Date().toISOString(); run.reason = 'interrupted'; changed = true;
      }
      if (changed) await this.save(c);
    }
  }
}
