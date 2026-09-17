## VERDICT

**(b) — mis-specified. No guidance can make it pass.** But the disposition is *not* "human rewrites it" and *not* "human marks it terminal". Let the ladder finish: the engine does it in one more cycle, unattended.

New evidence nobody in the debate had — this council run is `.sch-loop/council/20260917T002355Z-council-2fb524`, still open. What happens the instant I return a verdict, from `escalate.mjs:102-120`:

1. `ticket.council_rounds = 1`, `ticket.council_guidance = <this verdict>` persisted
2. `setTicketStatus(projectRoot, "T1.4a", " ")` — task.md line 15 goes `[!]` → **`[ ]`**
3. `watchdog.mjs:96` returns `COUNCIL`, loop continues, `taskmd.mjs:38` picks T1.4a up again
4. Executor runs **with this verdict in its brief**, gate exits 1, `build.mjs:158` sets `[!]`
5. Escalate again → `canConvene` hits `rounds >= MAX_COUNCIL_ROUNDS` (=1) → `needsHuman` → task.md `[?]`, event `ticket.needs_human`. `[?] !== " "`, so never dispatched again. **Terminal, in code.**

So every "human must edit the ticket" plan in the debate is wrong — three of them would race step 2.

## SCORECARD

| Disposition | corr 25 | sec 20 | maint 15 | test 15 | cplx 10 | perf 5 | rev 5 | ev 5 | **Σ** |
|---|---|---|---|---|---|---|---|---|---|
| **(b) + let ladder finish** | 25 | 20 | 15 | 15 | 10 | 5 | 5 | 5 | **100** |
| (b) + add fixture schema field | 18 | 20 | 8 | 15 | 3 | 3 | 3 | 2 | 72 |
| (b) + human marks terminal now | 14 | 18 | 9 | 13 | 6 | 4 | 4 | 3 | 71 |
| (a) retry as achievable | 0 | 20 | 5 | 2 | 8 | 0 | 4 | 0 | 39 |
| (b) + rewrite verifier to real gate | 5 | 10 | 6 | 0 | 7 | 4 | 2 | 1 | 35 |
| (c) split so verify becomes editable | 5 | 4 | 6 | 10 | 3 | 2 | 2 | 2 | 34 |

Security column = trust-boundary integrity. Testability = does the criterion-7 fixture survive.

## RATIONALE

- Gate verified constant: `.sch-loop/tickets/T1.4a-prove-the-council-convenes.json:14-22` is `node -e "process.exit(1)"`. Reads no argv, no file, no env. `tickets.mjs` maps `verify` verbatim to `verificationChecks`; no dispatch-time resolver exists. Settles the skeptic's open assumption.
- `allowed_paths: ["src/**"]`. The gate is not reachable from inside scope. (c) would grant an executor write access to its own acceptance test — boundary removal dressed as decomposition.
- Rewriting the gate destroys the fixture. Criterion 7 needs a permanently-unwinnable ticket; make it winnable and the next regression run proves nothing.
- Fixture terminality already exists — `needsHuman` `[?]` plus the persisted `council_rounds` cap. No schema field, no spec change. The adversarial challenge's demand is satisfied by code already written.
- Acceptance criterion 1 is **already met on a branch**: `sch/T1.4a-prove-the-council-convenes` @ `6a966d0` holds `src/impossible.mjs` (+ `impossible.test.mjs` @ `de3b760`). Unmerged because `passed:false`. Correct — do not cherry-pick; production tree gains dead code gated by a check designed never to pass.

## Instruction the next executor gets

> Create `src/impossible.mjs` exporting `function gate() { return true }`. That satisfies acceptance criterion 1 and is the whole of your legitimate work; one file, three lines.
>
> Acceptance criterion 2 ("the impossible gate check exits 0") is unsatisfiable and you are not expected to satisfy it. The check is `node -e "process.exit(1)"`, a constant, declared in `.sch-loop/tickets/T1.4a-prove-the-council-convenes.json` — outside your `allowed_paths` of `src/**`.
>
> Do not attempt to make it pass. Specifically: do not edit anything under `.sch-loop/`, do not alter the `verify` block, do not add a `process.exit(0)` shim, wrapper, env var, or `package.json` script that shadows the check, and do not touch task.md or ticket state. Any of those would be reported as a scope violation rather than a pass.
>
> Commit the file, then report NEEDS_DECISION on the first attempt — do not burn attempts 2 and 3. In your report state: gate is constant `node -e "process.exit(1)"`, independent of repository contents, not reachable from `src/**`; criterion 1 satisfied on branch `sch/T1.4a-prove-the-council-convenes`. Blocking on this ticket is the correct outcome; it is exit-criterion-7 apparatus.

## MATERIAL DISSENT (preserved, not resolved)

- **Skeptic, on (c):** a *human-owned* verifier-repair ticket is a legitimate split when the workflow separates implementation ownership from verification ownership. Correct in general. It does not apply here only because the verifier is not broken.
- **Adversarial challenge:** task.md `[!]` and `[?]` carry no distinction between "genuinely stuck, fix me" and "intentional fixture, expected to end here". A human scanning the board cannot tell. Real gap. Cheap remedy (one trailing comment on `task.md:15`), not a schema change — and not to be applied until round 2 lands, or it races `escalate.mjs:118`.
- **Architect, on pre-flight lint:** rejecting any `verify` argv that references no path under `allowed_paths` would catch this class statically. Also rejects this fixture. Ship it only with a fixture opt-out, which reintroduces the classification problem above.

## UNKNOWNS

1. Whether criterion 7 tests only "council convenes" or also verdict quality. If the latter, the pass/fail evidence is this document, and nothing automated reads it.
2. Council cost for this round — `usage`/`cost_usd` not inspected. An unwinnable ticket now costs one full council every time one is inserted.
3. Whether `[?]` is intended as "needs human" *and* "terminal fixture success", or whether the run will report criterion 7 as a failure because the ticket never reached `[x]`.
4. Ticket JSON `"status": "pending"` / `"attempts": 0` are never written back — `setTicketStatus` (duplicated at `build.mjs:23` and `escalate.mjs:23`) writes task.md only. Confirms the architect's own retraction: no three-way state disagreement, just two vestigial fields. Whether they are *meant* to be vestigial is unverified.

## REVERSAL CONDITIONS

- A dispatch-time rewriter that substitutes `verify` argv from ticket content → the constant is a placeholder, (a) becomes correct.
- `allowed_paths` widened at runtime to include `.sch-loop/tickets/**` for `type: build` → boundary already broken, (c) becomes correct and this is a fence defect.
- `MAX_COUNCIL_ROUNDS` raised, or `council_rounds` fails to persist through `saveTicket` → the loop can re-convene indefinitely; terminality must then be asserted by hand and the "human marks terminal" disposition wins.
- Round 2 lands on anything other than `[?]` → my whole chain (steps 1-5 above) is wrong; re-derive from `watchdog.mjs:96`.

## REQUIRED EVIDENCE / NEXT ACTION

**Next:** let the loop run one more cycle, then `grep -n 'T1.4a' task.md`. Expect `[?]`. That single glyph is the criterion-7 proof — council convened, re-dispatched with a verdict, failed, landed on human, cap held.

Two verified defects, separately ticketable — not part of this verdict:

1. `escalate.mjs:44` — on the `builder-needs-decision` path (`self-correct.mjs:179-184`) no `verification`, `judge`, `review`, or `error` is set, so `build.mjs:171-176` yields `[]` and the council is asked its question with `- (the report recorded no specific failure)`. The builder's actual reason is captured two lines up at `build.mjs:170` in `notes_for_next` and never read. **This council seat was handed a blank failure list and had to read the repo to answer.** Fix: have `failureQuestion` fall back to `notes_for_next`.
2. `setTicketStatus` is defined twice, identically, in `build.mjs:23` and `escalate.mjs:23`.

Want defect 1 drafted as a ticket?
