/**
 * GEODESIA — PAGE CONTENT CONTRACT
 * ---------------------------------------------------------------------------
 * Long-form, pre-rendered copy lives in `src/seo/content/*.ts` as typed data so
 * the Astro page templates stay pure presentation. This is what search crawlers
 * receive in the initial HTML payload: real engineering prose, not JS strings.
 */

export interface Feature {
  /** Short imperative feature name. */
  title: string;
  /** 1–2 sentence explanation, technical and specific. */
  text: string;
}

export interface Formula {
  /** Standard name of the method, e.g. "Gaussian shoelace". */
  name: string;
  /** Monospace expression, Unicode maths symbols welcome, one line where possible. */
  body: string;
  /** Plain-language explanation incl. units and edge cases. */
  note: string;
}

export interface Step {
  title: string;
  text: string;
}

export interface Faq {
  q: string;
  a: string;
}

export interface SpecRow {
  label: string;
  value: string;
}

export interface ToolPageContent {
  /** Route slug without leading slash, e.g. 'terrain-profile'. */
  slug: string;
  /** Small uppercase kicker above the h1. */
  eyebrow: string;
  /** Body h1 — may differ from the SEO <title> in site.ts. */
  h1: string;
  lede: string;
  /** Opening paragraphs rendered under the workspace. */
  intro: string[];
  /** Capability breakdown (3–6 items). */
  features: Feature[];
  /** Numbered operating procedure (3–5 items). */
  workflow: Step[];
  /** Verified method documentation (2–4 items) — the "how it is computed" block. */
  formulas: Formula[];
  /** Technical specification rows (datum, units, exports, limits). */
  specs: SpecRow[];
  /** 4–6 questions. Also emitted as FAQPage JSON-LD. */
  faqs: Faq[];
  /** Closing paragraph, may reference the open-source/verification stance. */
  closing: string;
}

export interface AboutSection {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
}

export interface AboutContent {
  eyebrow: string;
  h1: string;
  lede: string;
  sections: AboutSection[];
}
