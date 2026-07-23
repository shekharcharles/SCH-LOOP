# Recon — Chatbot + Embedded Modules (task 7)

Date 2026-07-24 · unauth, main.js + login surface.

## Chatbot
- No chatbot/webchat widget on pre-login surface; no vendor ref (kore/senseforth/haptik/
  yellow/liveperson/genesys) or external chat domain in main.js. "eva" matches were false
  positives (eValue/eValidator).
- HDFC EVA (if deployed in this retail-app) is **post-login / lazy-loaded** → map in the
  authenticated crawl (task 34). No black-box chatbot surface to test now.

## Embedded / client-side surface (→ task 19/20)
- main.js uses **iframe (19x), postMessage (9x), contentWindow (5x)** — embedded frames +
  cross-frame messaging present. Likely Backbase widgets / OAuth popup / embedded content.
- Origins not extractable from minified bundle → inspect message-event handlers + frame
  origins at runtime in client-side phase (task 19: postMessage origin abuse, frame checks).

## Telemetry note (minor)
- main.js embeds OpenTelemetry messaging semantic-convention strings
  (messaging.rabbitmq.routing_key, messaging.system, etc.) — OTel instrumentation compiled
  into client bundle. Low value; note only.

## Handoff
- Task 19: enumerate postMessage listeners + frame origins live; test origin validation.
- Task 34 (auth crawl): locate + map the chatbot module post-login.
