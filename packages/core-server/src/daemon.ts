import { connectTerminalDaemon } from '@roost/terminal-daemon/client';
export type DaemonClient = Awaited<ReturnType<typeof connectTerminalDaemon>>;
/** Connect-only: missing or incompatible owners never cause a process launch or DB open. */
export function createDaemonLink(socketPath:string) {
  let client:DaemonClient|undefined, stopped=false, error:string|null=null;
  let timer:ReturnType<typeof setTimeout>|undefined;
  async function connect() {
    try {
      const next=await connectTerminalDaemon(socketPath);
      if(stopped){next.dispose();return}
      client=next;error=null;
    } catch(cause) {
      error=cause instanceof Error?cause.message:'daemon unavailable';
      if(!stopped)timer=setTimeout(()=>{void connect()},1000);
    }
  }
  void connect();
  return {
    current:()=>client?.isConnected()?client:undefined,
    status:()=>({connected:client?.isConnected()??false,ownerPid:client?.isConnected()?client.ownerPid:null,error:client&&!client.isConnected()?'daemon disconnected':error}),
    close(){stopped=true;clearTimeout(timer);client?.dispose()},
  };
}
