import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('single worker polls automation and delivery and drains in-flight work on stop',async()=>{
  const runtime=await import('../src/workers/runner.mjs').catch(()=>null);
  assert.equal(typeof runtime?.runWorkers,'function','Production worker runner must exist');
  const controller=new AbortController();let started,release;
  const blocked=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
  const calls=[];
  const running=runtime.runWorkers({automation:{async runOnce(){calls.push('automation');started();await blocked;return 'job';}},
    delivery:{async runOnce(){calls.push('delivery');return null;}},signal:controller.signal,pollMs:5});
  await entered;controller.abort();let drained=false;running.then(()=>drained=true);
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(drained,false);
  release();await running;assert.deepEqual(calls,['automation','delivery']);
});

test('worker continues polling both queues after a transient database failure without leaking exception text',async()=>{
  const runtime=await import('../src/workers/runner.mjs').catch(()=>null);
  assert.equal(typeof runtime?.runWorkers,'function');
  const controller=new AbortController();let attempts=0,delivered=0;const errors=[];
  await runtime.runWorkers({automation:{async runOnce(){attempts++;throw Error('private credential');}},
    delivery:{async runOnce(){delivered++;if(delivered===2)controller.abort();return null;}},signal:controller.signal,pollMs:1,onError:code=>errors.push(code)});
  assert.equal(attempts,2);assert.equal(delivered,2);assert.deepEqual(errors,['WORKER_POLL_FAILED','WORKER_POLL_FAILED']);
});

test('Compose production worker uses its restricted URL and only environment secrets',()=>{
  const config=JSON.parse(execFileSync('docker',['compose','config','--format','json'],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,
    POSTGRES_PASSWORD:'owner-test-only',RUNTIME_DATABASE_URL:'postgres://rental_radar_web:runtime@postgres/rental_radar',
    WORKER_DATABASE_URL:'postgres://rental_radar_worker:runtime@postgres/rental_radar',SESSION_SECRET:'x'.repeat(32),OPENAI_API_KEY:'fake-no-live-calls',META_TOKEN_KEYS:'{}'}}));
  assert.ok(config.services.worker,'Compose must start a production worker');
  const worker=config.services.worker;
  assert.deepEqual(worker.command,['node','src/worker.mjs'],'SIGTERM must reach the runner without an npm wrapper');assert.match(worker.environment.DATABASE_URL,/rental_radar_worker/);
  for(const name of ['MIGRATION_DATABASE_URL','POSTGRES_PASSWORD','SESSION_SECRET'])assert.equal(worker.environment[name],undefined);
  assert.equal(worker.environment.OPENAI_API_KEY,'fake-no-live-calls');assert.equal(worker.environment.META_TOKEN_KEYS,'{}');
  assert.equal(worker.ports,undefined);assert.equal(worker.volumes,undefined);
});
