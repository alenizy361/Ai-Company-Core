# مشروع نمو cv.rabit.sa — «خذ الأفضل وحسّنه»

حزمة تنفيذ كاملة مبنية على أوديت تنافسي لـ 5 منافسين
(StylingCV, Sirity, LambaCV, Resumk, Cvyat) + أوديت ذاتي لموقع سيرة.

## المحتويات

```
AUDIT-IMPROVE.md          أوديت التحسين: كيف نسوي كل فكرة أفضل من صاحبها
implementation/           كود جاهز للصق في ريبو موقع cv.rabit.sa (Next.js)
  hreflang.tsx            مولّد hreflang لكل زوج صفحات ar/en
  middleware.ts           إصلاح ريدايركت الجذر (301 بدل 307 كوكيز)
  robots.txt              فتح زواحف الذكاء الاصطناعي
  pricing-trust.tsx       قسم الثقة لصفحة الأسعار (شعارات دفع + ضمان + شهادات)
  faq-schema.tsx          مكوّن FAQPage schema قابل لإعادة الاستخدام
content/                  محتوى 8 صفحات جاهز للنشر (عربي + صفحة إنجليزية)
CHECKLIST.md              قائمة التنفيذ بالترتيب
```

## طريقة النقل لريبو الموقع

1. انسخ ملفات `implementation/` لمواقعها في ريبو Next.js (المسارات مشروحة داخل كل ملف)
2. حوّل ملفات `content/` لصفحات (كل ملف فيه frontmatter كامل: title, meta, slug, keywords)
3. اتبع `CHECKLIST.md` بالترتيب
