// When a path traced job asks for renderer.backend "native" and the native tracer is not available, the job runs on the gpu
// or cpu backend. These helpers say so in the report and in any later error, so an agent sees why the scene hit a gpu limit.

/** The fields a job report carries when the backend it ran on is not the one it asked for. */
export function describeBackendFallback({ requestedBackend, usedBackend, fallbackReason }) {
  return { requestedBackend, usedBackend, fallbackReason };
}

/**
 * The error a fallen back job fails with, now naming the fallback. The original message stays first, so its own advice
 * (such as the triangle limit) still reads the same; the added sentence says why native was not used and what to pass.
 */
export function explainFailureAfterFallback(error, fallback) {
  if (!fallback || !(error instanceof Error)) return error;
  const { requestedBackend, usedBackend, fallbackReason } = fallback;
  error.message = `${error.message} renderer.backend "${requestedBackend}" was requested but the ${usedBackend} backend ran instead: ${fallbackReason} `
    + 'Make the native tracer available (see "The native backend" in docs/path-tracer.md), or simplify the scene to fit the '
    + `${usedBackend} tracer, or pass renderer.backend "${usedBackend}" to stop asking for native.`;
  return error;
}
