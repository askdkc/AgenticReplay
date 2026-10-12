# AgenticReplay

<sub>[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · **العربية**</sub>

<div dir="rtl">

AgenticReplay أداة لتسجيل اتصالات API للذكاء الاصطناعي، مخصّصة لتصحيح أخطاء بيئات تشغيل
الذكاء الاصطناعي (harness). تسجّل طلبات العملاء المدعومين واستجاباتهم، بما في ذلك محتوى
reasoning/thinking أو ملخّصاته التي تعيدها API بالفعل. لا يمكنها الحصول على التفكير الداخلي
الذي لا تكشفه API. تُحجب المعلومات الحساسة في المحتوى الملتقط قبل حفظه، وتُعلّم التسجيلات غير المكتملة.

قارن اتصالات API بنتائج الأدوات وأوامر الصدفة الملتقطة وتغييرات الملفات لفهم السلوك الفعلي
لبيئة التشغيل، وتحديد العيوب وتحسينها.

## التثبيت

يتطلب Node.js 24 أو أحدث، وGit، وبيئة تشغيل مثبتة مع بيانات اعتمادها المعتادة.

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

شغّل عبر AgenticReplay بيئة التشغيل التي ترسل طلبات API للذكاء الاصطناعي، مثل Claude Code،
وليس خادم MCP التابع لها وحده. تُحفظ التسجيلات في `.agenticreplay/runs/` داخل ذلك المشروع؛
ويختار `last` أحدث تسجيل. يتيح تصدير HTML فحص الأثر في المتصفح.

لبيئة تشغيل مخصّصة تستخدم `OPENAI_BASE_URL`:

```console
agenticreplay record generic-openai -- node agent.js
```

استبدل `node agent.js` بأمر تشغيل بيئتك. إذا سجّلت الدخول إلى Codex باشتراك ChatGPT،
فاستخدم اعتراض TLS:

```console
agenticreplay record exec --tls-intercept -- codex
```

تعمل بيئة التشغيل كالمعتاد أثناء التسجيل، وقد تترتب رسوم على استدعاءات API.
قد تتضمن الآثار بيانات حساسة من المشروع؛ راجعها قبل مشاركتها.

راجع [التكاملات](../integrations.md) لبيئات التشغيل الأخرى،
و[تصحيح أخطاء تشغيل فاشل](../how-to/debug-a-failing-agent-run.md) للاطلاع على مثال.

## الرخصة

Apache-2.0 للشفرة. ومواصفة الأثر برخصة CC BY 4.0، فيجوز لأي أحد إعادة تطبيقها.

</div>
