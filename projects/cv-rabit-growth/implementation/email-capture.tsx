// Light email capture — "send my CV to my email" before free download.
//
// WHERE IT GOES: shown in the download flow for the FREE (watermarked) tier,
// as an OPTIONAL step — download must still work without an email.
// Forcing it would recreate LambaCV's biggest UX complaint.
//
// Why: local-only storage means users lose work between visits (our audit's
// retention gap). Email = recovery link + the only follow-up channel.

'use client';

import { useState } from 'react';

export function EmailCaptureStep({
  onSkip,
  onSubmit,
}: {
  onSkip: () => void;
  onSubmit: (email: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div dir="rtl" className="space-y-3 rounded-xl border p-4">
      <p className="font-semibold">احفظ سيرتك قبل التحميل</p>
      <p className="text-sm text-gray-600">
        نرسل لك نسخة + رابط استرجاع تفتح منه سيرتك من أي جهاز. بدون حساب وبدون رسائل مزعجة —
        رسالة متابعة واحدة فقط، وإلغاء الاشتراك بنقرة.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try { await onSubmit(email); } finally { setBusy(false); }
        }}
        className="flex gap-2"
      >
        <input
          type="email"
          required
          dir="ltr"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="flex-1 rounded-lg border px-3 py-2"
        />
        <button disabled={busy} className="rounded-lg bg-black px-4 py-2 text-white">
          أرسل واحفظ
        </button>
      </form>
      <button onClick={onSkip} className="text-sm text-gray-400 underline">
        تخطَّ وحمّل مباشرة
      </button>
    </div>
  );
}

// BACKEND CONTRACT for onSubmit:
// 1. Store {email, resumeId, locale, created_at}.
// 2. Send ONE transactional email: PDF attached + magic recovery link.
// 3. Schedule ONE follow-up at +3 days: "قدّمت على الوظيفة؟ جهّز مقابلتك"
//    linking to the 35 SAR interview-prep upsell. Nothing else. Unsubscribe
//    link in both emails (سجل التجارة السعودي + PDPL compliance).
