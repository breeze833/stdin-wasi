// stdin-wasi: High-performance, zero-dependency synchronous stdin provider for WASI Preview 1

export {
  STATE_IDLE,
  STATE_WAITING,
  STATE_READY,
  STATE_EOF,
  CONTROL_STATE_IDX,
  CONTROL_LEN_IDX,
  CONTROL_READ_POS_IDX,
  CONTROL_RESERVED_IDX,
  DATA_OFFSET,
  DEFAULT_BUFFER_SIZE,
  ESUCCESS,
  EBADF,
  EINVAL,
  EIO,
} from './buffer.js';

export { StdinHost } from './host.js';
export { StdinWorker, createStdinReader } from './worker.js';
