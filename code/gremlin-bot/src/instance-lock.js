// Only one copy of the bot at a time. A second one (say, start-windows.bat while the
// Winslow app already runs him) would answer everyone twice. The lock is a local
// port held open while the bot runs: Windows frees it the moment the bot exits,
// even if it crashes, so a stale lock can never block a start.

import net from 'node:net';

export const LOCK_PORT = 8177;

/** Resolves to a handle while this is the only copy, or null if another one is running. */
export function holdInstanceLock(port = LOCK_PORT) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', (err) => {
      // Something else on that port, or no networking at all: don't block starting over it.
      resolve(err.code === 'EADDRINUSE' ? null : { close() {} });
    });
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.unref();
      resolve(server);
    });
  });
}
