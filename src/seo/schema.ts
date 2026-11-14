/**
 * GEODESIA — JSON-LD STRUCTURED DATA
 * ---------------------------------------------------------------------------
 * Schema.org graphs emitted in <head>. Kept as plain builders so pages can
 * compose exactly the graph they need (and so the QA harness can validate).
 */

import { ENGINE, SITE, TOOLS, TOOL_ORDER, type ToolDef, type ToolId } from './site';

export type JsonLd = Record<string, unknown>;

const abs = (path: string): string => new URL(path, SITE.url).href;

/** Organization node — authorship + contact for every page graph. */
export function organizationSchema(): JsonLd {
  return {
    '@type': 'Organization',
    '@id': `${SITE.url}/#organization`,
    name: SITE.name,
    legalName: SITE.legalName,
    url: SITE.url,
    logo: {
      '@type': 'ImageObject',
      url: abs('/brand/geodesia-mark-512.png'),
      width: 512,
      height: 512,
    },
    image: abs(SITE.ogImage),
    email: SITE.email,
    description: SITE.description,
    foundingDate: SITE.founded,
    knowsAbout: [
      'Geodesy',
      'Land surveying',
      'WGS 84',
      'Elevation profiles',
      'Polygon area computation',
      'Cadastral measurement',
      'Geographic information systems',
    ],
  };
}

/** WebSite node — site identity, publisher, primary search action. */
export function websiteSchema(): JsonLd {
  return {
    '@type': 'WebSite',
    '@id': `${SITE.url}/#website`,
    url: SITE.url,
    name: SITE.name,
    alternateName: SITE.domain,
    description: SITE.description,
    inLanguage: SITE.lang,
    publisher: { '@id': `${SITE.url}/#organization` },
  };
}

/** SoftwareApplication node for one instrument. */
export function toolSchema(id: ToolId): JsonLd {
  const tool: ToolDef = TOOLS[id];
  return {
    '@type': ['WebApplication', 'SoftwareApplication'],
    '@id': `${abs(tool.path)}#application`,
    name: `${tool.name} — ${SITE.name}`,
    url: abs(tool.path),
    description: tool.metaDescription,
    applicationCategory: 'UtilitiesApplication',
    applicationSubCategory: 'Land surveying and geodesy',
    operatingSystem: 'Any (modern web browser)',
    browserRequirements: 'Requires JavaScript. No installation, no account.',
    isAccessibleForFree: true,
    inLanguage: SITE.lang,
    keywords: tool.keywords.join(', '),
    featureList: tool.keywords,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
    },
    publisher: { '@id': `${SITE.url}/#organization` },
    author: { '@id': `${SITE.url}/#organization` },
    softwareHelp: { '@type': 'CreativeWork', url: abs(`${tool.path}#method`) },
  };
}

/** ItemList of every instrument — used on the home page. */
export function toolListSchema(): JsonLd {
  return {
    '@type': 'ItemList',
    '@id': `${SITE.url}/#instruments`,
    name: 'Geodesia instruments',
    itemListElement: TOOL_ORDER.map((id, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: TOOLS[id].name,
      url: abs(TOOLS[id].path),
      description: TOOLS[id].blurb,
    })),
  };
}

/** BreadcrumbList from a trail of { label, href } (home is prepended). */
export function breadcrumbSchema(
  trail: Array<{ label: string; href: string }>,
  includeHome = true,
): JsonLd {
  const items = [
    ...(includeHome ? [{ label: 'Geodesia', href: '/' }] : []),
    ...trail,
  ];
  return {
    '@type': 'BreadcrumbList',
    '@id': `${abs(trail[trail.length - 1]?.href ?? '/')}#breadcrumb`,
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.label,
      item: abs(item.href),
    })),
  };
}

/** FAQPage node. */
export function faqSchema(faqs: Array<{ q: string; a: string }>): JsonLd {
  return {
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.q,
      acceptedAnswer: { '@type': 'Answer', text: faq.a },
    })),
  };
}

/** TechArticle for the method/formula documentation sections. */
export function methodArticleSchema(args: {
  headline: string;
  description: string;
  path: string;
  datePublished?: string;
  section?: string;
}): JsonLd {
  return {
    '@type': 'TechArticle',
    '@id': `${abs(args.path)}#method`,
    headline: args.headline,
    description: args.description,
    url: abs(args.path),
    inLanguage: SITE.lang,
    articleSection: args.section ?? 'Surveying methods',
    datePublished: args.datePublished ?? '2025-02-01',
    dateModified: new Date().toISOString().slice(0, 10),
    author: { '@id': `${SITE.url}/#organization` },
    publisher: { '@id': `${SITE.url}/#organization` },
    about: ENGINE.ellipsoid,
  };
}

/** Wrap nodes into a single @graph document. */
export function graph(...nodes: JsonLd[]): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@graph': nodes.filter(Boolean),
  };
}
