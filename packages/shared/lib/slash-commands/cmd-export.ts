import { t } from '@extension/i18n';
import { getChat } from '@extension/storage';
import { toast } from 'sonner';
import type { ChatMessage, ChatMessagePart } from '../chat-types.js';
import type { SlashCommandDef } from './types.js';

const roleLabel = (role: ChatMessage['role']): string => {
  switch (role) {
    case 'user':
      return 'User';
    case 'assistant':
      return 'Assistant';
    case 'system':
      return 'System';
  }
};

const formatPart = (part: ChatMessagePart): string | null => {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'reasoning':
      return `<details>\n<summary>Reasoning</summary>\n\n${part.text}\n</details>`;
    case 'tool-call':
      return `> Used tool: **${part.toolName}**`;
    default:
      return null;
  }
};

const formatMessages = (title: string, messages: ChatMessage[]): string => {
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [`# ${title}`, '', `*Exported on ${date}*`, ''];

  for (const msg of messages) {
    lines.push(`## ${roleLabel(msg.role)}`, '');
    for (const part of msg.parts) {
      const text = formatPart(part);
      if (text) {
        lines.push(text, '');
      }
    }
    lines.push('---', '');
  }

  return lines.join('\n');
};

const sanitizeFilename = (name: string): string =>
  name
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'conversation';

const exportCommand: SlashCommandDef = {
  name: 'export',
  description: 'Export conversation as a Markdown file',
  execute: async ctx => {
    if (ctx.messages.length === 0) {
      toast.error(t('slash_exportEmpty'));
      return;
    }

    const chat = await getChat(ctx.chatId);
    const title = chat?.title || 'Untitled Conversation';
    const markdown = formatMessages(title, ctx.messages);

    const date = new Date().toISOString().slice(0, 10);
    const filename = `${sanitizeFilename(title)}-${date}.md`;

    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    ctx.clearInput();
    toast.success(t('slash_exported'));
  },
};

export { exportCommand };
