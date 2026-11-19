import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const origin = process.argv[2] ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
let checks = 0;

try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    for (const route of ['/', '/downloads.html', '/docs.html', '/getting-started.html']) {
      await page.goto(origin + route);
      if (route === '/downloads.html') await page.waitForURL(origin + '/#downloads');
      if (route === '/getting-started.html') await page.waitForURL(origin + '/docs.html#install');
      await page.locator('.navigation nav a .nav-label').first().waitFor();
      for (const width of [320, 390, 580, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        const linkPositions = await page.locator('.navigation nav a').evaluateAll(links => links.map(link => link.getBoundingClientRect().top));
        assert.ok(linkPositions.every(top => Math.abs(top - linkPositions[0]) < 1), 'Library navigation wraps to another row');
        const contrast = await page.locator('.navigation nav a').first().evaluate(link => {
          const channels = color => color.match(/[\d.]+/g).map(Number);
          const backgrounds = [];
          for (let element = link; element; element = element.parentElement) {
            backgrounds.unshift(channels(getComputedStyle(element).backgroundColor));
          }
          let background = [255, 255, 255];
          for (const layer of backgrounds) {
            const opacity = layer[3] ?? 1;
            background = background.map((channel, index) => layer[index] * opacity + channel * (1 - opacity));
          }
          const luminance = color => color.slice(0, 3).map(channel => {
            const value = channel / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          }).reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
          const backgroundLight = luminance(background);
          const ratio = element => {
            const foregroundLight = luminance(channels(getComputedStyle(element).color));
            return (Math.max(foregroundLight, backgroundLight) + 0.05) / (Math.min(foregroundLight, backgroundLight) + 0.05);
          };
          const icon = link.querySelector('svg');
          return { text: ratio(link), icon: icon ? ratio(icon) : null };
        });
        assert.ok(contrast.text >= 4.5, `${route} ${colorScheme} ${width}: active text contrast ${contrast.text.toFixed(2)} < 4.5`);
        if (contrast.icon !== null) {
          assert.ok(contrast.icon >= 3, `${route} ${colorScheme} ${width}: active icon contrast < 3`);
        }
        checks += 1;
      }
    }
  }
  console.log(`Navigation contrast passed: ${checks} page/theme/viewport combinations.`);
  const layoutChecks = [];
  const siteFolder = fileURLToPath(new URL('../site/', import.meta.url));
  const pages = readdirSync(siteFolder).filter(file => file.endsWith('.html') && file !== 'file.html' && file !== 'downloads.html' && file !== 'getting-started.html');
  for (const fileName of pages) {
    await page.goto(`${origin}/${fileName}`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.locator('nav[aria-label="Site"] a').first().waitFor();
    for (const width of [1440, 1152, 960, 900, 820, 768, 650, 620, 600, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      const layout = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        items: [...document.querySelectorAll('nav[aria-label="Site"] a, .toolbar-actions button, .site-nav-cta, #save-image, .brand')].map(item => ({
          text: item.textContent.trim() || item.getAttribute('aria-label'),
          left: item.getBoundingClientRect().left,
          right: item.getBoundingClientRect().right,
          width: item.getBoundingClientRect().width,
        })),
      }));
      assert.ok(layout.scrollWidth <= layout.innerWidth + 1, `${fileName} ${width}: horizontal overflow`);
      for (const item of layout.items) {
        if (!item.width) continue;
        assert.ok(item.left >= -1 && item.right <= layout.innerWidth + 1, `${fileName} ${width}: ${item.text} is clipped`);
      }
      layoutChecks.push(`${fileName} ${width}`);
    }
  }
  console.log(`Navigation layout passed: ${layoutChecks.length} page/viewport combinations.`);
} finally {
  await browser.close();
}
