import { commands } from './registry.js';
import type { SlashCommandDef, SlashCommandContext } from './types.js';

/** Only matches when the entire message is a slash command (e.g. "/help").
 *  "hello /help" or "/help\nmore text" are NOT treated as commands — sent to LLM. */
const parseSlashCommand = (input: string): { command: string; args: string } | null => {
  if (input.includes('\n') || input.includes('\r')) return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.match(/^\/([a-z_]+)(?:\s+(.*))?$/i);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!commands.some(c => c.name === name)) return null;
  const args = (match[2] ?? '').trim();
  console.debug('[slash-cmd] parsed command:', name, 'args:', args);
  return { command: name, args };
};

const getSlashCommands = (): readonly SlashCommandDef[] => commands;

const executeSlashCommand = async (name: string, ctx: SlashCommandContext): Promise<boolean> => {
  const cmd = commands.find(c => c.name === name);
  if (!cmd) return false;
  console.debug('[slash-cmd] executing:', name);
  try {
    await cmd.execute(ctx);
    console.debug('[slash-cmd] completed:', name);
  } catch (err) {
    console.debug('[slash-cmd] error in', name, err);
    throw err;
  }
  return true;
};

export { parseSlashCommand, getSlashCommands, executeSlashCommand };
export type { SlashCommandDef, SlashCommandContext };
