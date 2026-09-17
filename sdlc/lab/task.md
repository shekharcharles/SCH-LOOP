# task.md — lab
<!-- SCH-LOOP:TASKS — read top to bottom. Never renumber. Insert = suffix (T1.4a-slug). -->
<!-- [ ] pending  [~] in progress  [x] done  [!] blocked  [?] needs human -->
<!-- line: - [status] ID-slug  type  Title  deps:ID,ID|-  size:XS|S|M|L  [council:true] [gate:blocking-human] -->

(empty — written by sch-tickets after brainstorm → prd → architecture → plan)


## Phase 1 — Todo core   (3/6 done)
- [x] T1.1-add-priority-to-todo  build  Add priority to todo items  deps:-  size:S
- [x] T1.2-cover-remove-and-list  test  Cover remove and list isolation  deps:T1.1  size:S
- [x] T1.2a-document-the-priority-vocabulary  docs  Document the priority vocabulary  deps:T1.1  size:XS
- [?] T1.3-eyeball-the-priority-api  human  Eyeball the priority API surface  deps:T1.1  size:XS  gate:blocking-human
- [?] T1.4-slow-chore-for-kill  chore  Slow chore for kill test  deps:T1.1  size:S
- [?] T1.4a-prove-the-council-convenes  build  Prove the council convenes  deps:-  size:S

## Phase 2 — Filtering   (2/2 done)
- [x] T2.1-filter-the-list-by  build  Filter the list by priority  deps:-  size:S
- [x] T2.1a-prove-filtered-list-returns  test  Prove filtered list returns copies  deps:-  size:XS