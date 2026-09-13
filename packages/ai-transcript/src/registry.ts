import {readOmpTranscript, type TranscriptCheckpoint} from './index.ts';
import {readClaudeTranscript} from './claude.ts';
import {readCodexTranscript} from './codex.ts';
import {readOpenCodeTranscript} from './opencode.ts';
import {readGrokTranscript} from './grok.ts';
import {readQwenTranscript} from './qwen.ts';
import {readGeminiTranscript} from './gemini.ts';

export type TranscriptAdapter = Readonly<{
  id: string;
  source: 'file' | 'http';
  coverage: 'recorded_supported_entries' | 'bounded_snapshot' | 'recorded_chunks';
  read: (path: string, nativeId: string, previous?: TranscriptCheckpoint) => ReturnType<typeof readOmpTranscript>;
}>;

// Keep provider selection here; a CLI name alone never enables message sending.
const adapters: readonly TranscriptAdapter[] = Object.freeze([
  {id:'omp',source:'file',coverage:'recorded_supported_entries',read:(...args: Parameters<typeof readOmpTranscript>)=>readOmpTranscript(...args)},
  {id:'claude',source:'file',coverage:'recorded_supported_entries',read:readClaudeTranscript},
  {id:'codex',source:'file',coverage:'recorded_supported_entries',read:readCodexTranscript},
  {id:'grok',source:'file',coverage:'recorded_chunks',read:readGrokTranscript},
  {id:'qwen',source:'file',coverage:'recorded_supported_entries',read:readQwenTranscript},
  {id:'gemini',source:'file',coverage:'bounded_snapshot',read:readGeminiTranscript},
  {id:'opencode',source:'http',coverage:'bounded_snapshot',read:readOpenCodeTranscript},
].map(adapter=>Object.freeze(adapter)) as TranscriptAdapter[]);
export function getTranscriptAdapter(cliId: string): TranscriptAdapter | undefined {
  return adapters.find(adapter=>adapter.id===cliId);
}
export function listTranscriptAdapters(): readonly TranscriptAdapter[] { return adapters; }
