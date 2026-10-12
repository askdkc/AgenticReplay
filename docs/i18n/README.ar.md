# AgenticReplay

<sub>[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · **العربية**</sub>

<div dir="rtl">

يسجّل AgenticReplay اتصالات API لتشخيص أخطاء بيئات تشغيل وكلاء الذكاء الاصطناعي وتحسينها.
يلتقط طلبات العملاء المدعومين واستجاباتهم، بما فيها محتوى reasoning/thinking أو ملخّصاته التي تعيدها API فعليًا.

قارن السجل بنتائج الأدوات وأوامر الصدفة الملتقطة وتغييرات الملفات لتحديد موضع الخلل أثناء التشغيل.

## التثبيت

يتطلب Node.js 24 أو أحدث، وGit، وبيئة تشغيل وكلاء ذكاء اصطناعي مُهيّأة للاستخدام.

```console
git clone https://github.com/askdkc/AgenticReplay.git
cd AgenticReplay
npm ci
npm run build
npm install -g .
agenticreplay doctor
```

## الاستخدام

نفّذ هذه الأوامر داخل المشروع الذي تريد فحصه:

```console
agenticreplay record claude -- -p "Investigate the failing test"
agenticreplay show last
agenticreplay export last -o run.html
```

سجّل العملية التي ترسل طلبات API، مثل Claude Code. تُحفظ السجلات في `.agenticreplay/runs/`
داخل المشروع؛ ويختار `last` أحدث تسجيل. افتح `run.html` في المتصفح لفحصه.

إذا كانت بيئتك المخصّصة تقرأ `OPENAI_BASE_URL`، فاستبدل `node agent.js` بأمر تشغيلها:

```console
agenticreplay record generic-openai -- node agent.js
```

لاستخدام Codex باشتراك ChatGPT، استخدم اعتراض TLS:

```console
agenticreplay record exec --tls-intercept -- codex
```

قد تترتب رسوم على استدعاءات API أثناء التسجيل. قد تبقى بيانات حساسة في السجلات رغم الحجب التلقائي؛ راجعها قبل مشاركتها.

راجع [دليل التكامل](../integrations.md) لبيئات التشغيل الأخرى،
و[تصحيح أخطاء تشغيل فاشل](../how-to/debug-a-failing-agent-run.md) للاطلاع على مثال.

## الرخصة

Apache-2.0. مواصفة السجل: CC BY 4.0.

</div>
