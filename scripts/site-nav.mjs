export const siteNavLinks = [
  { href: './studio.html', label: 'Studio' },
  { href: './docs.html', label: 'Docs' },
  { href: './recipes.html', label: 'Recipes' },
  { href: './index.html#examples', label: 'Showcase' },
  { href: './marketplace.html', label: 'Marketplace' },
  { href: './changelog.html', label: 'Changelog' },
];

export function renderSiteNav(currentHref, className = '') {
  const classAttribute = className ? ` class="${className}"` : '';
  const links = siteNavLinks
    .map(link => `<a href="${link.href}"${link.href === currentHref ? ' aria-current="page"' : ''}>${link.label}</a>`)
    .join('');
  return `<nav${classAttribute} aria-label="Site">${links}</nav>`;
}
