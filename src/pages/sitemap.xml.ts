import type { APIRoute } from 'astro';
import { ROUTES, SITE } from '../seo/site';

/**
 * Static sitemap — emitted at build time as `/sitemap.xml`.
 *
 * Generated from the same route table the navigation uses, so a page cannot be
 * added to the site and forgotten here. Absolute https URLs, no trailing slash
 * (matching `trailingSlash: 'never'` + Vercel `cleanUrls`), and `<lastmod>` from
 * the build date.
 */
export const GET: APIRoute = () => {
  const lastmod = new Date().toISOString().slice(0, 10);

  const urls = ROUTES.map((route) => {
    const loc = new URL(route.path, SITE.url).href;
    return [
      '  <url>',
      `    <loc>${loc}</loc>`,
      `    <lastmod>${lastmod}</lastmod>`,
      `    <changefreq>${route.changefreq}</changefreq>`,
      `    <priority>${route.priority.toFixed(1)}</priority>`,
      '  </url>',
    ].join('\n');
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
