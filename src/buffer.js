// Buffer memory layout and state constants for stdin-wasi

export const STATE_IDLE = 0;
export const STATE_WAITING = 1;
export const STATE_READY = 2;
export const STATE_EOF = -1;

export const CONTROL_STATE_IDX = 0;
export const CONTROL_LEN_IDX = 1;
export const CONTROL_READ_POS_IDX = 2;
export const CONTROL_RESERVED_IDX = 3;

// Data payload begins at byte offset 16 (immediately after the 4 x 32-bit control words)
export const DATA_OFFSET = 16;

export const DEFAULT_BUFFER_SIZE = 8192; // 8 KB

export const ESUCCESS = 0;
export const EBADF = 8;
export const EINVAL = 28;
export const EIO = 29;
