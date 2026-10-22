import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('stop during delayed automation drains that invocation without claiming delivery',async()=>{
  const runtime=await import('../src/workers/runner.mjs').catch(()=>null);
  assert.equal(typeof runtime?.runWorkers,'function','Production worker runner must exist');
  const controller=new AbortController();let started,release;
  const blocked=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
  const calls=[];
  const running=runtime.runWorkers({automation:{async runOnce(){calls.push('automation');started();await blocked;return 'job';}},
    delivery:{async runOnce(){calls.push('delivery');return null;}},signal:controller.signal,pollMs:5});
  await entered;controller.abort();let drained=false;running.then(()=>drained=true);
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(drained,false);
  release();await running;assert.deepEqual(calls,['automation']);
});

test('stop during delivery settles that invocation and never claims the next automation job',async()=>{
  const {runWorkers}=await import('../src/workers/runner.mjs');
  const controller=new AbortController();let entered,release;
  const waiting=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve),calls=[];
  const running=runWorkers({automation:{async runOnce(){calls.push('automation');return null;}},
    delivery:{async runOnce(){calls.push('delivery');entered();await barrier;calls.push('settled');return 'sent';}},signal:controller.signal});
  await waiting;controller.abort();assert.deepEqual(calls,['automation','delivery']);
  release();await running;assert.deepEqual(calls,['automation','delivery','settled']);
});

test('worker continues polling both queues after a transient database failure without leaking exception text',async()=>{
  const runtime=await import('../src/workers/runner.mjs').catch(()=>null);
  assert.equal(typeof runtime?.runWorkers,'function');
  const controller=new AbortController();let attempts=0,delivered=0;const errors=[];
  await runtime.runWorkers({automation:{async runOnce(){attempts++;throw Error('private credential');}},
    delivery:{async runOnce(){delivered++;if(delivered===2)controller.abort();return null;}},signal:controller.signal,pollMs:1,onError:code=>errors.push(code)});
  assert.equal(attempts,2);assert.equal(delivered,2);assert.deepEqual(errors,['WORKER_POLL_FAILED','WORKER_POLL_FAILED']);
});

test('scheduler runtime isolates failures prevents overlap and stops cleanly',async()=>{
  const {runScheduler}=await import('../src/workers/runner.mjs');
  const controller=new AbortController();let calls=0,active=0,maxActive=0;const events=[];
  await runScheduler({scheduler:{async tick(){calls++;active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,2));active--;if(calls===1)throw Error('private schedule data');controller.abort();return {scheduled:0};}},signal:controller.signal,pollMs:1,onEvent:event=>events.push(event)});
  assert.equal(calls,2);assert.equal(maxActive,1);assert.deepEqual(events,[{code:'SCHEDULER_TICK_FAILED'},{code:'SCHEDULER_TICK_COMPLETED',scheduled:0,skipped:0,considered:0}]);
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(calls,2,'shutdown prevents another tick');
});

test('Compose production worker uses its restricted URL and only environment secrets',()=>{
  const config=JSON.parse(execFileSync('docker',['compose','config','--format','json'],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,
    POSTGRES_PASSWORD:'owner-test-only',RUNTIME_DATABASE_URL:'postgres://rental_radar_web:runtime@postgres/rental_radar',
    WORKER_DATABASE_URL:'postgres://rental_radar_worker:runtime@postgres/rental_radar',SESSION_SECRET:'x'.repeat(32),OPENAI_API_KEY:'fake-no-live-calls',META_TOKEN_KEYS:'{}',GROUP_COMMAND_KEY_ID:'group-current',GROUP_COMMAND_KEYS:'{"group-current":"encoded"}'}}));
  assert.ok(config.services.worker,'Compose must start a production worker');
  const worker=config.services.worker;
  for(const name of ['web','worker']) {
    assert.equal(config.services[name].init,true);
    assert.equal(config.services[name].stop_grace_period,'2m0s','Allow two 30s OpenAI calls plus database settlement');
  }
  assert.deepEqual(worker.command,['node','src/worker.mjs'],'SIGTERM must reach the runner without an npm wrapper');assert.match(worker.environment.DATABASE_URL,/rental_radar_worker/);
  for(const name of ['MIGRATION_DATABASE_URL','POSTGRES_PASSWORD','SESSION_SECRET'])assert.equal(worker.environment[name],undefined);
  assert.equal(worker.environment.OPENAI_API_KEY,'fake-no-live-calls');assert.equal(worker.environment.META_TOKEN_KEYS,'{}');
  assert.equal(worker.environment.GROUP_COMMAND_KEY_ID,'group-current');assert.equal(worker.environment.GROUP_COMMAND_KEYS,'{"group-current":"encoded"}');
  assert.equal(worker.ports,undefined);assert.equal(worker.volumes,undefined);
});
