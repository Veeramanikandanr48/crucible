// The browser side of the `icons` job: one scene per item in the job page, drawn through the same preview API as every other job.
import { iconRecipe } from '../src/icon-sheet.js';
import { renderIconJob } from './agent-icon-job.mjs';

const SCREENSHOT_OPTIONS = { fromSurface: true, format: 'png', optimizeForSpeed: true };

/**
 * Draws every item of an icons job in `jobPage` (already on the preview page and sized to the icon) and writes the job's files.
 * `assetData(recipe)` returns the catalog bytes the recipe places, in the form `create` reads them.
 */
export async function renderIconsInPage({ jobPage, jobId, settings, directory, signal, progress, assetData, memoryBudgetMiB, backend, tier }) {
  const cdp = await jobPage.context().newCDPSession(jobPage);
  // A transparent canvas shows the page behind it in a screenshot, so the page and the browser's default are made clear.
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await jobPage.evaluate(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
  });
  const metrics = { backend, requestedWidth: settings.size, requestedHeight: settings.size, drawCount: 0 };

  async function openItem(item, index) {
    if (!item.asset) throw new Error(`items[${index}] (${item.source}) has no pinned asset id. The runtime pins catalog names when the job is submitted.`);
    const recipe = iconRecipe({ assetId: item.asset, style: settings.style, view: settings.viewpoint, size: settings.size });
    const input = { sessionId: jobId, recipe, memoryBudgetMiB, backend, transparent: true, ...(tier ? { tier } : {}), ...(await assetData(recipe)) };
    const created = await jobPage.evaluate(createInput => window.__agentPreview.create(createInput), input)
      .catch(error => { throw new Error(`items[${index}] (${item.source}) could not be loaded: ${String(error.message).split('\n')[0]}`); });
    try {
      if (created.render.width < settings.size || created.render.height < settings.size) {
        throw new Error(`The render budget reduced the frame to ${created.render.width}x${created.render.height}, below the ${settings.size} px icon. Start the server with a larger --memory or ask for a smaller size.`);
      }
      const inspected = await jobPage.evaluate(sessionId => window.__agentPreview.inspect({ sessionId }), jobId);
      const bounds = inspected.assets?.[0]?.bounds;
      if (!bounds) throw new Error(`items[${index}] (${item.source}) placed no geometry. Check that the GLB holds meshes.`);
      return {
        bounds,
        async draw(camera) {
          signal.throwIfAborted();
          const frame = await jobPage.evaluate(drawInput => window.__agentPreview.frame(drawInput), { sessionId: jobId, camera });
          if (backend === 'cpu' && !/swiftshader/i.test(frame.graphics)) throw new Error('CPU job did not select SwiftShader.');
          metrics.graphics = frame.graphics;
          metrics.drawCount++;
          metrics.width = frame.width;
          metrics.height = frame.height;
          const captured = await cdp.send('Page.captureScreenshot', SCREENSHOT_OPTIONS);
          return Buffer.from(captured.data, 'base64');
        },
        async close() {
          await jobPage.evaluate(sessionId => window.__agentPreview.dispose({ sessionId }), jobId);
        },
      };
    } catch (error) {
      await jobPage.evaluate(sessionId => window.__agentPreview.dispose({ sessionId }), jobId).catch(() => {});
      throw error;
    }
  }

  const result = await renderIconJob({ settings, directory, signal, progress, openItem });
  return { artifacts: result.artifacts, metrics: { ...metrics, ...result.metrics } };
}
