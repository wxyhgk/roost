/** Queue status is separate from native transcript messages. */
export type AiCommandState = 'queued' | 'writing' | 'awaiting_acceptance' | 'accepted' | 'failed' | 'uncertain' | 'cancelled';
export type AiCommandInput = {requestId:string;type:'submit';terminalInstanceId:string;generation:string;nativeSessionId:string;text:string};
export type AiCommand = AiCommandInput & {
  webSessionId:string;seq:number;revision:number;status:AiCommandState;reason:string|null;
  createdAt:number;updatedAt:number;writtenAt:number|null;inputEpoch:number|null;sourceSeq:number|null;
  hookSeq:number|null;nativeMessageId:string|null;transcriptOffset:number|null;
};
export type AiControl = {supported:boolean;reason:string|null;inputEpoch:number;queue:AiCommand[]};
export type AiCommandPage = {items:AiCommand[];nextCursor:number|null};
export const MAX_AI_COMMAND_BYTES = 16 * 1024;
export const MAX_AI_QUEUED_COMMANDS = 20;
export class AiCommandError extends Error {
  readonly status:number;readonly code:string;
  constructor(status:number,code:string){super(code);this.status=status;this.code=code;}
}

export function validateAiCommandInput(value:unknown):asserts value is AiCommandInput {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new AiCommandError(400,'invalid_request');
 const input=value as AiCommandInput;
 for(const key of ['requestId','terminalInstanceId','generation','nativeSessionId'] as const)
  if(typeof input[key]!=='string'||!input[key].trim()||input[key].length>512)throw new AiCommandError(400,'invalid_request');
 if(input.type!=='submit'||typeof input.text!=='string'||!input.text.trim()||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(input.text)||input.text.trimStart().startsWith('/')||/[\uD800-\uDFFF]/u.test(input.text))throw new AiCommandError(400,'invalid_request');
 let byteLength=0;
 for(const char of input.text){const code=char.codePointAt(0)!;byteLength+=code<=0x7f?1:code<=0x7ff?2:code<=0xffff?3:4;}
 if(byteLength>MAX_AI_COMMAND_BYTES)throw new AiCommandError(413,'too_large');
}
