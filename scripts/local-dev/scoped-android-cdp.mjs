import WebSocket from 'ws';
import { setTimeout, clearTimeout } from 'node:timers';

/** Attach the test runner only to tabs it creates, avoiding stalled/personal existing tabs. */
export async function connectOwnAndroidChrome(chromium, endpoint) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Android CDP connection timed out'));
    }, 10000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  let privateId = 1000000000;
  const pending = new Map(),
    creating = new Set(),
    ownedTargets = new Set(),
    ownedSessions = new Set(),
    pageSessions = new Map();
  const transport = {
    send(message) {
      if (!message.sessionId && message.method === 'Target.setAutoAttach') {
        // Playwright normally initializes every existing page. This session owns none of those.
        socket.send(
          JSON.stringify({
            ...message,
            params: { ...message.params, autoAttach: false, waitForDebuggerOnStart: false },
          }),
        );
      } else {
        if (!message.sessionId && message.method === 'Target.createTarget')
          creating.add(message.id);
        socket.send(JSON.stringify(message));
      }
    },
    close() {
      socket.close();
    },
  };
  function request(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++privateId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Android ${method} timed out`));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  socket.on('message', async (data) => {
    const message = JSON.parse(data.toString());
    if (pending.has(message.id)) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
      return;
    }
    if (creating.delete(message.id) && message.result?.targetId) {
      const targetId = message.result.targetId;
      ownedTargets.add(targetId);
      try {
        // Forward the real attached event before resolving newPage(), matching Chrome's ordering.
        await request('Target.attachToTarget', { targetId, flatten: true });
      } catch {
        transport.onmessage?.({
          id: message.id,
          error: { code: -32000, message: 'Could not attach the new test tab' },
        });
        return;
      }
    }
    if (message.method === 'Target.attachedToTarget') {
      if (
        !ownedTargets.has(message.params.targetInfo.targetId) &&
        !ownedSessions.has(message.sessionId)
      )
        return;
      ownedSessions.add(message.params.sessionId);
      if (message.params.targetInfo.type === 'page')
        pageSessions.set(message.params.targetInfo.targetId, message.params.sessionId);
    } else if (message.method === 'Target.detachedFromTarget') {
      if (!ownedSessions.delete(message.params.sessionId)) return;
    } else if (message.method?.startsWith('Target.target')) {
      if (!ownedTargets.has(message.params.targetId ?? message.params.targetInfo?.targetId)) return;
    } else if (message.sessionId && !ownedSessions.has(message.sessionId)) return;
    transport.onmessage?.(message);
  });
  socket.on('close', () => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error('Android CDP disconnected'));
    }
    pending.clear();
    transport.onclose?.();
  });
  try {
    const browser = await chromium.connectOverCDP(transport, { noDefaults: true, timeout: 30000 });
    return {
      browser,
      request,
      pageRequest(method, params) {
        const sessionId = [...pageSessions.values()].at(-1);
        if (!sessionId) throw new Error('No owned Android test page');
        return request(method, params, sessionId);
      },
      disconnect: () => socket.close(),
    };
  } catch (error) {
    socket.close();
    throw error;
  }
}
