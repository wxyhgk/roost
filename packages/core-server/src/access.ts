import type { IncomingMessage } from 'node:http';
/** Small, frozen localhost boundary; intentionally does not import the business gateway. */
export function createCoreAccess(extraOrigins:string[] = []) {
  const origins=new Set(['http://localhost:5173','http://127.0.0.1:5173',...extraOrigins]);
  for(const value of origins){const url=new URL(value);if(url.origin!==value||!['http:','https:'].includes(url.protocol))throw new Error('exact HTTP(S) origin required')}
  return (req:IncomingMessage)=>{
    try {
      const host=req.headers.host;
      if(!host||/[\s/@\\?#]/.test(host))return false;
      const url=new URL('http://'+host);
      if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||Number(url.port||80)!==req.socket.localPort)return false;
      const origin=req.headers.origin;
      if(origin===undefined)return req.headers['sec-fetch-site']!=='cross-site';
      return typeof origin==='string'&&(origins.has(origin)||origin===url.origin);
    }catch{return false}
  };
}
