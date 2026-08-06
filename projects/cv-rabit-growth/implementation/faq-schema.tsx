// Reusable FAQPage JSON-LD component.
//
// WHERE IT GOES: shared components dir; render once per page that has an FAQ
// section (pricing page + every content/ page — each content draft ends with
// 5-6 Q&As written for exactly this).
//
// Why: the audit showed Sirity wins rich results with FAQ schema on thin
// content. Ours goes on deep pages → higher CTR on the same rankings.

type Faq = { q: string; a: string };

export function FaqSchema({ faqs }: { faqs: Faq[] }) {
  if (!faqs.length) return null;
  const json = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(json) }}
    />
  );
}

// RULES (Google policy — violations get the whole site's rich results pulled):
// - The same Q&As MUST be visible on the page, not schema-only.
// - No promotional-only answers; answer the actual question first.
// - One FAQPage block per page maximum.
//
// VERIFICATION: paste the deployed URL into
// https://search.google.com/test/rich-results → FAQ detected, 0 errors.
