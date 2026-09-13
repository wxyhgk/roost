/** Reserve 1 KiB of the native 16 KiB command budget for trusted source labels. */
export const MAX_PEER_TEXT_BYTES = 15 * 1024;
export type PeerActor = {kind:"user"} | {kind:"agent";conversationId:string;runId:string};
export type PeerSendInput = {recipientId:string;requestId:string;text:string;inReplyTo?:string|null};
export type PeerMessage = {
  id:string;senderKind:"user"|"agent";senderConversationId:string|null;senderRunId:string|null;
  senderScope:string;requestId:string;recipientId:string;text:string;format:"text/v1";createdAt:number;inReplyTo:string|null;
};
export type PeerDeliveryState = "queued"|"dispatching"|"accepted"|"failed"|"uncertain"|"cancelled";
export type PeerDelivery = {
  id:string;messageId:string;recipientId:string;enqueueSeq:number;state:PeerDeliveryState;reason:string|null;
  revision:number;createdAt:number;updatedAt:number;targetRunId:string|null;targetSourceId:string|null;targetOwnerEpoch:number|null;
  commandSessionId:string|null;commandRequestId:string;terminalInstanceId:string|null;generation:string|null;nativeSessionId:string|null;
  commandDigest:string|null;acceptedNativeMessageId:string|null;acceptedAt:number|null;
};
export type PeerMessagePreview = Omit<PeerMessage,"text"> & {preview:string;truncated:boolean};
export type PeerMessageDetail = {message:PeerMessage;delivery:PeerDelivery};
export type PeerPage = {items:{message:PeerMessagePreview;delivery:PeerDelivery}[];nextCursor:string|null};
export class PeerMessageError extends Error {
  status:number;code:string;
  constructor(status:number,code:string,message=code){super(message);this.name="PeerMessageError";this.status=status;this.code=code;}
}
