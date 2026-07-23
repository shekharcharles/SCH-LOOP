<!-- SCH Loop method body for domain: app-dev. Default engine flow; sch-run encodes the loop. This file tells the builder WHICH installed skill to use WHEN, so it never hand-rolls frontend work the skills already do better. -->

# App development — method body

Build one feature task at a time from the PRD-derived queue. Reuse the installed
skills below — **do not hand-roll UI, motion, or design systems the skills cover.**

## Which skill, when (frontend)

| The task involves… | Invoke |
| --- | --- |
| New page/UI from scratch, needs to not look templated | `taste-skill` (anti-slop direction), then build |
| Polishing / auditing / hardening an existing interface | `impeccable` (UX + visual + a11y review, then fix) |
| Redesigning / upgrading an existing screen | `redesign-skill` (audit generic patterns → premium) |
| Extracting a design system / tokens from a reference or screenshot | `design-dna` |
| A specific visual style | `minimalist-skill` / `soft-skill` / `brutalist-skill` |
| A brand board / logo system / identity | `brandkit` |
| React / Next.js structure + state | `nextjs-app-router-patterns`, `react-state-management`, `react-modernization` |
| General component/layout engineering | `frontend-ui-engineering`, `web-component-design`, `design-system-patterns` |
| Tailwind styling / token system | `tailwindcss`, `tailwind-design-system` |
| Responsive / mobile-web behavior | `responsive-design` |
| Motion / transitions / micro-interactions | `motion-design` (principles), then GSAP: `gsap-core`, `gsap-timeline`, `gsap-react` |
| Scroll-driven / pinned / parallax | `gsap-scrolltrigger` (+ `gsap-performance` to keep 60fps) |
| 3D / WebGL / shaders | `threejs-fundamentals` + `threejs-materials`/`threejs-lighting`/`threejs-animation`/`threejs-shaders` as needed |
| Chart / dashboard / data viz | `dataviz` |
| Accessibility must pass | `accessibility-compliance`, `wcag-audit-patterns` |
| React Native app (not web) | `react-native-architecture`, `react-native-design`, `mobile-ios-design`/`mobile-android-design` |
| Long/complete code output without truncation | `output-skill` |
| **Backend — Python** | `fastapi-templates`, `python-project-structure`, `async-python-patterns`, `python-testing-patterns`, `python-error-handling`, `python-type-safety`, `python-background-jobs` |
| **Backend — Node** | `nodejs-backend-patterns`, `modern-javascript-patterns`, `typescript-advanced-types` |
| **Backend — .NET / Go** | `dotnet-backend-patterns`, `go-concurrency-patterns` |
| **Database** | `postgresql-table-design`, `sql-optimization-patterns`, `database-migration`, `domain-modeling` |
| **API design** | `api-design-principles`, `api-and-interface-design`, `openapi-spec-generation`, `graphql` patterns |
| **Architecture** | `architecture-patterns`, `microservices-patterns`, `cqrs-implementation`, `event-store-design`, `saga-orchestration`, `domain-modeling` |
| **Reliability / observability** | `error-handling-patterns`, `observability-and-instrumentation`, `distributed-tracing`, `slo-implementation`, `python-resilience` |
| **Testing** | `test-driven-development`, `tdd`, `e2e-testing-patterns`, `property-based-testing`, `mutation-testing`, `javascript-testing-patterns` |
| **CI/CD / infra** | `ci-cd-and-automation`, `github-actions-templates`, `gitops-workflow`, `k8s-manifest-generator`, `helm-chart-scaffolding`, `terraform-module-library` |
| **Security in dev** | `owasp-security`, `secrets-management`, `auth-implementation-patterns`, `security-and-hardening` |
| **Perf / quality** | `performance-optimization`, `code-review-and-quality`, `code-simplification`, `debugging-strategies` |

Pick the smallest set the task needs — direction skill first (if new/redesign),
then build, then motion/3d only if the AC calls for it. Match the repo's existing
stack and style; don't introduce a new framework for one task.

## Loop steps

- **Build:** implement only the task's `AC-N`; `NG-N` binding; dispatch per table.
- **Validate:** real browser via Playwright MCP — launch app, drive the AC flow,
  screenshot, read console + network. Fix + re-validate. For visual/UI tasks,
  compare against the design direction; a `[VALIDATION]` fail if it looks off.
- **Review:** fresh `/sch-review` subagent against the AC.
- **Complete:** merge the branch to default; task → merged.
- **Deliver (sch-ship):** production build + deploy via the project's own path;
  tag a release. No deploy path → hand the final publish step to the user.
