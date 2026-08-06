// Pricing-page trust section — payment logos, guarantee, testimonials, live counter.
//
// WHERE IT GOES: rendered on the pricing page, directly ABOVE the plan cards
// (guarantee + payment methods) and BELOW them (testimonials + counter).
// Styling uses plain Tailwind-ish classes — adapt to the site's design system.
//
// HARD RULE: testimonials must be real. Ship with testimonials={[]} until you
// have genuine ones (the array renders nothing when empty). Never fabricate.

type Testimonial = {
  name: string;      // first name only, e.g. "عبدالله"
  city: string;      // e.g. "الرياض"
  role: string;      // e.g. "محاسب"
  quote: string;     // their actual words
};

export function GuaranteeBanner() {
  return (
    <div dir="rtl" className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-center">
      <p className="font-bold text-emerald-800">ضمان استرداد كامل خلال 7 أيام</p>
      <p className="text-sm text-emerald-700">
        ما عجبتك النتيجة؟ نرجّع لك المبلغ كامل — بدون أسئلة.
      </p>
    </div>
  );
}

export function PaymentMethods() {
  // Use real logo assets in /public/payments/ — mada and Apple Pay logos are
  // available from their official brand kits (mada: SAMA brand guidelines,
  // Apple Pay: Apple marketing resources). Paylink processes all of these.
  const methods = [
    { src: '/payments/mada.svg', alt: 'مدى' },
    { src: '/payments/apple-pay.svg', alt: 'Apple Pay' },
    { src: '/payments/visa.svg', alt: 'Visa' },
    { src: '/payments/mastercard.svg', alt: 'Mastercard' },
  ];
  return (
    <div dir="rtl" className="flex items-center justify-center gap-4 py-3">
      <span className="text-sm text-gray-500">ادفع بأمان عبر:</span>
      {methods.map((m) => (
        <img key={m.alt} src={m.src} alt={m.alt} className="h-6" loading="lazy" />
      ))}
    </div>
  );
}

export function PriceAnchor() {
  return (
    <p dir="rtl" className="text-center text-sm text-gray-600">
      مكاتب كتابة السيرة الذاتية في السعودية تبدأ من <s>169 ريال</s> —
      مع سيرة تحصل على أكثر بـ <strong>35 ريال</strong> فقط، دفعة واحدة بدون اشتراك.
    </p>
  );
}

export function Testimonials({ items }: { items: Testimonial[] }) {
  if (!items.length) return null;
  return (
    <section dir="rtl" className="grid gap-4 sm:grid-cols-3">
      {items.map((t) => (
        <figure key={t.name + t.city} className="rounded-xl border p-4">
          <blockquote className="text-sm">"{t.quote}"</blockquote>
          <figcaption className="mt-2 text-xs text-gray-500">
            {t.name} · {t.role} · {t.city}
          </figcaption>
        </figure>
      ))}
    </section>
  );
}

// Honest usage counter — value must come from the real database
// (e.g. SELECT count(*) FROM resumes WHERE created_at > now() - interval '7 days').
// Hide the component below a floor so early numbers don't undermine trust.
export function UsageCounter({ weeklyCount }: { weeklyCount: number }) {
  if (weeklyCount < 25) return null;
  return (
    <p dir="rtl" className="text-center text-sm text-gray-600">
      🎉 {weeklyCount.toLocaleString('ar-SA')} سيرة ذاتية أُنشئت هذا الأسبوع
    </p>
  );
}
