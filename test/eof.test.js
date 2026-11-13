// Automated Unit Tests: EOF Signaling, Channel Reset, and StdinWorker Class

import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  StdinHost,
  StdinWorker,
  createStdinReader,
  ESUCCESS,
  STATE_IDLE,
  STATE_EOF,
} from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerHelperPath = path.join(__dirname, 'worker_helper.js');

test('EOF: sendEof Wakes Waiting Worker with 0 Bytes Read', async () => {
  const host = new StdinHost();
  const worker = new Worker(workerHelperPath);

  try {
    await new Promise((resolve) => {
      worker.once('message', resolve);
      worker.postMessage({ cmd: 'init', sharedBuffer: host.getSharedBuffer() });
    });

    const requestPromise = new Promise((resolve) => {
      worker.on('message', function onReq(msg) {
        if (msg.type === 'stdin_request') {
          worker.off('message', onReq);
          resolve();
        }
      });
    });

    worker.postMessage({ cmd: 'read', iovs: [32] });
    await requestPromise;
    assert.equal(host.isWaiting(), true);

    const readDonePromise = new Promise((resolve) => {
      worker.on('message', function onDone(msg) {
        if (msg.status === 'read_done') {
          worker.off('message', onDone);
          resolve(msg);
        }
      });
    });

    // Send EOF (Ctrl-D)
    host.sendEof();
    assert.equal(host.getState(), STATE_EOF);

    const result = await readDonePromise;
    assert.equal(result.ret, ESUCCESS);
    assert.equal(result.nread, 0); // 0 bytes read marks standard EOF

    // Subsequent read without reset immediately returns 0 bytes
    const read2Promise = new Promise((resolve) => {
      worker.on('message', function onDone(msg) {
        if (msg.status === 'read_done') {
          worker.off('message', onDone);
          resolve(msg);
        }
      });
    });
    worker.postMessage({ cmd: 'read', iovs: [32] });
    const res2 = await read2Promise;
    assert.equal(res2.ret, ESUCCESS);
    assert.equal(res2.nread, 0);
  } finally {
    await worker.terminate();
  }
});

test('Channel Reset & Reuse', async () => {
  const host = new StdinHost();
  host.sendEof();
  assert.equal(host.getState(), STATE_EOF);

  host.reset();
  assert.equal(host.getState(), STATE_IDLE);

  // Ready to accept new input after reset
  host.sendInput('reused\n');
  assert.equal(host.getState(), 2);
});

test('StdinWorker: Class Lifecycle and Method Delegation', () => {
  const memory = new ArrayBuffer(1024);
  const view = new DataView(memory);

  const worker = new StdinWorker({
    stdinBytes: 'hello',
    getMemory: () => memory,
  });

  view.setUint32(0, 100, true);
  view.setUint32(4, 5, true);
  const nreadPtr = 10;

  const ret = worker.read(0, 1, nreadPtr);
  assert.equal(ret, ESUCCESS);
  assert.equal(view.getUint32(nreadPtr, true), 5);

  // Switch to new preloaded bytes
  worker.setPreloadedStdin('world');
  const ret2 = worker.read(0, 1, nreadPtr);
  assert.equal(ret2, ESUCCESS);
  assert.equal(view.getUint32(nreadPtr, true), 5);
  const text = new TextDecoder().decode(new Uint8Array(memory, 100, 5));
  assert.equal(text, 'world');

  // Reader access
  const readerFn = worker.getReader();
  assert.equal(typeof readerFn, 'function');
});
