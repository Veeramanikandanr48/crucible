// Writes the recipe pages of the site (site/recipes.html and site/recipe-<slug>.html) from scripts/recipe-catalog.mjs and the recipe
// files in public/recipes/. The code block on a page is the recipe file's own text, so the page shows exactly what the pictures were
// drawn from; tests/site-recipes.test.js fails when a page and its file disagree.
// Usage: node scripts/make-recipe-pages.mjs        write the pages
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeSource, RECIPES, recipeSource } from './recipe-catalog.mjs';

const siteFolder = fileURLToPath(new URL('../site/', import.meta.url));
const ORIGIN = 'https://crucible.codepawl.com';

const NAVIGATION_LINKS = [
  { href: '/docs.html', label: 'Docs' },
  { href: '/recipes.html', label: 'Recipes' },
  { href: '/marketplace.html', label: 'Marketplace' },
  { href: '/changelog.html', label: 'Changelog' },
];

export function pageFileName(slug) {
  return `recipe-${slug}.html`;
}

export function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function navigation(currentHref) {
  const links = NAVIGATION_LINKS.map(link => `<a href="${link.href}"${link.href === currentHref ? ' aria-current="page"' : ''}>${link.label}</a>`).join('');
  return `<a class="brand" href="/" aria-label="Crucible home">Crucible</a>
      <nav aria-label="Library">${links}</nav>
      <a class="site-nav-cta" href="https://github.com/codepawl/crucible" aria-label="GitHub"><span class="package-logo package-logo-github" aria-hidden="true"></span><span class="site-nav-cta-label">GitHub</span></a>`;
}

function pageShell({ title, description, path, currentHref, body }) {
  return `<!doctype html>
<html lang="en" data-theme="crucible">
  <head>
    <meta charset="UTF-8" /><script>try{var saved=localStorage.getItem("crucible-color");if(saved==="light"||saved==="dark")document.documentElement.dataset.color=saved}catch(error){}</script>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${ORIGIN}${path}" />
    <title>${escapeHtml(title)} · Crucible</title>
    <link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml" /><link rel="icon" href="/favicon.ico?v=2" sizes="48x48" /><link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  </head>
  <body class="site recipes">
    <a class="skip-link" href="#content">Skip to content</a>
    <header class="navigation">
      ${navigation(currentHref)}
    </header>
    <main id="content">
${body}
    </main>
    <footer class="site-footer" aria-label="Site footer">
      <p><a class="brand" href="/" aria-label="Crucible home">Crucible</a> by <a href="https://codepawl.com">CodePawl</a></p>
      <nav class="footer-links" aria-label="Project links"><a href="https://github.com/codepawl/crucible"><span class="package-logo package-logo-github" aria-hidden="true"></span>GitHub</a><a href="https://www.npmjs.com/package/@codepawlhq/crucible"><span class="package-logo package-logo-npm" aria-hidden="true"></span>npm</a><a href="/changelog.md">Changelog</a><a href="/license.txt">MIT license</a></nav>
    </footer>
    <script type="module" src="/src/recipes.js"></script>
  </body>
</html>
`;
}

function frameFigure(recipe, frame) {
  return `<figure><img src="/recipes/${recipe.slug}-${frame.id}.webp" width="960" height="540" alt="${escapeHtml(`${recipe.title}: ${frame.label}`)}" /><figcaption>${escapeHtml(frame.label)}</figcaption></figure>`;
}

function codeBlock({ id, heading, source }) {
  return `      <section class="recipe-code" aria-labelledby="${id}-title">
        <div class="recipe-code-heading"><h2 id="${id}-title">${escapeHtml(heading)}</h2><button type="button" data-copy-code="${id}">Copy</button></div>
        <pre><code id="${id}">${escapeHtml(source)}</code></pre>
      </section>`;
}

function mediaSection(recipe) {
  const [before, after] = recipe.frames;
  const stills = `<div class="recipe-pair">${frameFigure(recipe, before)}${frameFigure(recipe, after)}</div>`;
  if (!recipe.clip) return `      ${stills}`;
  const poster = `/recipes/${recipe.slug}-${before.id}.webp`;
  const clip = `<video class="recipe-clip" src="/recipes/${recipe.slug}.mp4" poster="${poster}" width="960" height="540" muted loop playsinline autoplay aria-label="${escapeHtml(`${recipe.title}, rendered by Crucible`)}"></video>`;
  return `      ${clip}\n      ${stills}`;
}

export function renderRecipePage(recipe) {
  const path = `/${pageFileName(recipe.slug)}`;
  const whyLines = recipe.why.map(line => `<p>${escapeHtml(line)}</p>`).join('');
  const before = beforeSource(recipe.slug);
  const blocks = [codeBlock({ id: 'scene-code', heading: 'Scene code', source: recipeSource(recipe.slug) })];
  if (before) blocks.push(codeBlock({ id: 'before-code', heading: `Merge into the environment for “${recipe.frames[0].label}”`, source: before }));
  const body = `      <p class="recipe-back"><a href="/recipes.html"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>Recipes</a></p>
      <h1>${escapeHtml(recipe.title)}</h1>
${mediaSection(recipe)}
      <div class="recipe-why">${whyLines}</div>
${blocks.join('\n')}
      <p class="recipe-file"><a href="/recipes/${recipe.slug}.json" download>Download ${recipe.slug}.json</a><span>Paste it into <code>scene_create</code> as <code>recipe</code>.</span></p>`;
  return pageShell({ title: recipe.title, description: recipe.summary, path, currentHref: '/recipes.html', body });
}

export function renderIndexPage() {
  const cards = RECIPES.map(recipe => `        <a class="recipe-card" href="/${pageFileName(recipe.slug)}">
          <img src="/recipes/${recipe.slug}-after.webp" width="960" height="540" alt="" loading="lazy" />
          <h2>${escapeHtml(recipe.title)}</h2>
          <p>${escapeHtml(recipe.summary)}</p>
        </a>`).join('\n');
  const body = `      <h1>Recipes</h1>
      <div class="recipe-list">
${cards}
      </div>`;
  return pageShell({ title: 'Recipes', description: 'One rendering technique per page: a before and after picture, why it matters and the scene code that made it.', path: '/recipes.html', currentHref: '/recipes.html', body });
}

export function renderRecipePages() {
  const pages = { 'recipes.html': renderIndexPage() };
  for (const recipe of RECIPES) pages[pageFileName(recipe.slug)] = renderRecipePage(recipe);
  return pages;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [fileName, html] of Object.entries(renderRecipePages())) {
    writeFileSync(`${siteFolder}${fileName}`, html);
    console.log(`wrote site/${fileName}`);
  }
}
