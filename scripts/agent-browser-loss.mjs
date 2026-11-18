// What a render job reports when the preview browser dies under it (#2018) or its page navigates away (#2198). Playwright words a
// lost page or browser in several ways; the job failure names the frame, the size and the passes so the caller knows which limit to lower.
const BROWSER_LOSS_PATTERN = /target (page, context or browser )?(has been )?closed|(page|target|browser) (has )?crashed|browser has been closed|browser (has )?disconnected|connection closed|protocol error|session closed/i;
// A page that reloaded or navigated under a call: its context is gone, and the new document has no `window.__agentPreview` yet.
const PAGE_LOST_PATTERN = /execution context was destroyed|cannot read properties of (undefined|null) \(reading '(dispose|create|frame|resume|suspend)'\)|__agentPreview is (undefined|not defined)/i;

export function isBrowserLoss(error) {
  const message = String(error?.message ?? error);
  return BROWSER_LOSS_PATTERN.test(message) || PAGE_LOST_PATTERN.test(message);
}

/** True when the page navigated or reloaded, so its preview bridge is gone, rather than the browser dying. */
export function isPageLost(error) {
  return PAGE_LOST_PATTERN.test(String(error?.message ?? error));
}

export function describeBrowserLoss({ error, frameIndex, frameCount, width, height, passes = [], memoryMiB, estimatedPeakMemoryMiB }) {
  const where = frameIndex < 0
    ? 'before the first frame'
    : `while rendering ${frameCount > 1 ? 'still' : 'frame'} ${frameIndex + 1} of ${frameCount}`;
  const passNote = passes.length ? ` with ${passes.join(', ')} ${passes.length === 1 ? 'pass' : 'passes'}` : '';
  const cause = String(error?.message ?? error).split('\n')[0];
  const what = isPageLost(error) ? 'The preview page navigated or reloaded' : 'The preview browser crashed';
  const estimateNote = estimatedPeakMemoryMiB > memoryMiB ? ` The estimate was ${estimatedPeakMemoryMiB} MiB against the budget, so memory is the likely cause.` : '';
  return new Error(`${what} ${where} at ${width}x${height}${passNote} (${cause}).${estimateNote} Lower the size or the frame count, or raise --memory (now ${memoryMiB} MiB). The server is still running.`, { cause: error });
}
