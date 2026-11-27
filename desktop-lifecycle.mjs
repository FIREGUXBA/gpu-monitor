// One quit path for normal exit, installer handoff and a startup that failed after the
// monitor was already running. Startup is awaited but its failure never skips cleanup.
export function createShutdown({ startup, stop, cleanup = () => {}, quit, onError = console.error }) {
  let started = false;
  let done = false;
  return {
    get started() {
      return started;
    },
    get done() {
      return done;
    },
    run(action = quit) {
      if (started) return;
      started = true;
      const task = (async () => {
        try {
          await Promise.resolve().then(startup).catch(() => {});
          await stop();
        } finally {
          done = true;
          try {
            await cleanup();
          } finally {
            action();
          }
        }
      })();
      task.catch(onError);
      return task;
    },
  };
}
