import test from 'node:test';
import assert from 'node:assert/strict';
import {watchFiles} from '../src/shared/api/fileWatch';

function fixture(t: import('node:test').TestContext) {
  t.mock.timers.enable({apis:['setTimeout']});
  const sockets: FakeSocket[]=[];
  class FakeSocket {
    closed=false;
    onopen: (()=>void)|null=null;
    onclose: ((event:{code:number;reason:string})=>void)|null=null;
    onerror: (()=>void)|null=null;
    constructor(){sockets.push(this)}
    close(){this.closed=true;this.onclose?.({code:1006,reason:''})}
  }
  for(const [key,value] of Object.entries({WebSocket:FakeSocket,window:{location:{href:'http://fixture/'}}})){
    const before=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{value,configurable:true});
    t.after(()=>{if(before)Object.defineProperty(globalThis,key,before);else Reflect.deleteProperty(globalThis,key)});
  }
  return sockets;
}

test('slow file-watch handshake is not aborted by error callback; timeout retries once',t=>{
  const sockets=fixture(t);const stop=watchFiles('/tmp',()=>{});
  try {
    t.mock.timers.tick(20_000);assert.equal(sockets[0].closed,false);
    sockets[0].onerror?.();assert.equal(sockets[0].closed,false);
    t.mock.timers.tick(25_000);assert.equal(sockets[0].closed,true);
    t.mock.timers.tick(500);assert.equal(sockets.length,2);
    sockets[1].onopen?.();t.mock.timers.tick(60_000);
    assert.equal(sockets[1].closed,false);assert.equal(sockets.length,2);
  }finally{stop();}
});
test('watch resource rejection stops retries and exposes manual refresh',t=>{
  const sockets=fixture(t);let stopped=0;
  const stop=watchFiles('/tmp',()=>{},()=>stopped++);
  try{
    sockets[0].onopen?.();sockets[0].onclose?.({code:1011,reason:'watch unavailable'});
    t.mock.timers.tick(120_000);
    assert.equal(stopped,1);assert.equal(sockets.length,1);
  }finally{stop();}
});
