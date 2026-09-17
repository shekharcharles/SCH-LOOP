---
name: sch-learn
description: SCH-LOOP v2 structured learning from rejections, regressions, Council predictions, and outcomes.
---

# SCH Learn

Capture reusable lessons after failures, rejections, course corrections, reviews, and shipping outcomes.

Write structured lessons to `.sch-loop/learning/lessons.jsonl`.

Each lesson should include:
- source;
- ticket/run;
- failure;
- preventive rule;
- relevant paths;
- category/tags.

Retrieve only relevant lessons for a future ticket. Do not dump the entire history into every Builder context.

A loop that catches the same mistake forever is verification without learning.
