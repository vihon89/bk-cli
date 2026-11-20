import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {osVault} from '../src/credential-store.mjs';
test('Linux vault uses Secret Service stdin, verifies write and fails closed',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bk-secret-service-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const id='a'.repeat(64);let value=null;
  const vault=osVault(dir,{platform:'linux',run:async(command,args,input)=>{
    assert.equal(command,'secret-tool');assert.ok(!args.join(' ').includes('private-secret'));
    if(args[0]==='store'){value=input;return {code:0,output:''};}
    if(args[0]==='clear'){value=null;return {code:0,output:''};}
    return {code:value?0:1,output:value||''};
  }});
  assert.equal(await vault.read(id),null);await vault.write(id,'private-secret');assert.equal(await vault.read(id),'private-secret');await vault.remove(id);assert.equal(await vault.read(id),null);
  const unavailable=osVault(dir,{platform:'linux',run:async()=>({code:2,output:''})});await assert.rejects(unavailable.write(id,'private-secret'),e=>e.code==='SECURE_STORE_UNAVAILABLE');
});
