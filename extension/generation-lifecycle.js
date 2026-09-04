export function createGenerationKeepAlive({ setTimer, clearTimer, ping, intervalMs = 15000 }) {
  let active = null;

  function stop(requestId = null) {
    if (!active) return false;
    if (requestId && active.requestId !== requestId) return false;
    clearTimer(active.timerId);
    active = null;
    return true;
  }

  function start(requestId) {
    stop();
    active = {
      requestId,
      timerId: setTimer(ping, intervalMs)
    };
  }

  return { start, stop };
}
