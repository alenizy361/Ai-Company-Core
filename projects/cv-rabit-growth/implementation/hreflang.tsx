// hreflang generator — covers every ar/en page pair sitewide.
//
// WHERE IT GOES (Next.js App Router): merge into each route's generateMetadata,
// or centralize in a shared helper imported by all page.tsx files.
// For Pages Router: render <HreflangTags /> inside <Head> in _document/_app.
//
// Why: the audit found ZERO competitors ship hreflang. Without it, Google
// can serve the EN page to AR searchers (and vice versa) and the two
// versions cannibalize each other. First mover wins both SERPs.

const SITE = 'https://cv.rabit.sa';

/**
 * App Router usage inside generateMetadata:
 *
 *   export async function generateMetadata({ params }): Promise<Metadata> {
 *     return {
 *       alternates: hreflangAlternates(params.slugPath), // e.g. 'resume-examples/accountant'
 *     };
 *   }
 */
export function hreflangAlternates(slugPath: string) {
  const path = slugPath.replace(/^\/+|\/+$/g, '');
  const suffix = path ? `/${path}` : '';
  return {
    canonical: undefined, // keep your existing per-page canonical
    languages: {
      'ar-SA': `${SITE}/ar${suffix}`,
      ar: `${SITE}/ar${suffix}`,
      en: `${SITE}/en${suffix}`,
      'x-default': `${SITE}/ar${suffix}`, // primary audience is Arabic
    },
  };
}

/** Pages Router fallback: render inside <Head> */
export function HreflangTags({ slugPath }: { slugPath: string }) {
  const alts = hreflangAlternates(slugPath).languages;
  return (
    <>
      {Object.entries(alts).map(([lang, href]) => (
        <link key={lang} rel="alternate" hrefLang={lang} href={href} />
      ))}
    </>
  );
}

// VERIFICATION after deploy:
// 1. curl -s https://cv.rabit.sa/ar/ats-resume-checker | grep hreflang
//    → must show ar-SA, en, x-default lines
// 2. Google Search Console → International Targeting: errors must trend to 0
// 3. Pages that exist only in one language: SKIP hreflang there (a tag
//    pointing to a 404 twin is worse than none) — gate on the twin existing.
