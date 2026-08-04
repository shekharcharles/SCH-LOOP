# Contained worker execution (M6)

**Status:** Approved design, not yet implemented
**Date:** 2026-08-05
**Supersedes:** nothing
**Depends on:** the supervised runner, the delivery controller and the sequential
graph scheduler, all of which ship today

---

## 1. Why this exists

SCH Loop today runs a worker as your Windows user, in your working tree, with
your `PATH` and with `credential.helper = manager` reachable. The README states
this plainly and concludes that fully unattended operation is not supported.
That conclusion is correct, and it blocks the three things that would actually
make SCH Loop useful day to day: an authenticated control plane, a supervisor
daemon that keeps going, and a phone that can steer it.

Each of those means *SCH acts while nobody is watching*. Building any of them on
an uncontained worker is building a remote trigger for a process that holds your
credentials.

This milestone narrows the blast radius so the other three become defensible.

### The four pains, and which milestone owns each

| Pain | Owner |
|---|---|
| Cannot leave it running | S3, supervisor daemon |
| Cannot drive it from a phone | S2, authenticated control plane |
| Every project drags every global skill | S4, project-local materialization |
| It stops and does not continue | S3, supervisor daemon |

**M6 fixes none of these directly.** It is the precondition for S2 and S3. S4 is
independent of it and can be built in parallel.

### What was rejected, and why

Four containment shapes were considered:

- **Docker.** Strongest boundary by construction — no host filesystem, no
  credential vault, controllable network. Rejected for now because each managed
  project needs an image capable of running that project's own build and test
  commands, and bind-mounting a repository from `D:` is slow. It remains the
  right second provider.
- **A second Windows local user.** A real kernel boundary with no new dependency,
  and the DPAPI-bound credential vault becomes genuinely unreachable. Rejected
  because `claude` is installed per-user under `nvm4w`, so the worker account has
  neither node nor the CLI; it needs its own Claude login; and launching a
  process as another user from Node requires a service or a scheduled task.
- **WSL2 with a dedicated Unix user.** Rejected because managed repositories live
  on `D:`, and `/mnt/d` has no real permissions and poor I/O. Moving repositories
  into the WSL filesystem is a larger change than this milestone.
- **Blast-radius reduction.** Selected. Roughly a tenth of the cost of the
  others, delivers most of the unattended value, and leaves the strong providers
  available later.

## 2. Scope, stated as a claim and a non-claim

**Claimed after this milestone:**

- A worker cannot modify the repository working tree you use.
- A worker cannot reach your git credential helper.
- A worker cannot push anything.
- Any file a worker changes outside its own worktree root is a forbidden effect.

**Not claimed, and to remain documented as unsolved:**

- A worker can still write elsewhere on disk.
- A worker can still make network calls.
- A worker can still spawn a process that detaches and outlives the run.
- This is not OS-level sandboxing.

The existing "Worker containment: what is not true yet" section of the README is
narrowed by this milestone, not deleted. S2 and S3 inherit the remaining caveats
and must say so.

## 3. Worktree lifecycle

One worktree **per task**, not per attempt. The scheduler already guarantees that
a retry inherits the previous attempt's uncommitted work rather than discarding
it, and that guarantee must survive.

```
create   on task claim
         git worktree add <root>/<project>/<task> -b sch/task-<n> <base>
base     the project branch HEAD at the moment the task is claimed
root     outside the managed repository, and outside SCH_HOME:
         Windows  %LOCALAPPDATA%\sch-loop\worktrees
         POSIX    ${XDG_STATE_HOME:-$HOME/.local/state}/sch-loop/worktrees
         overridable per project by an operator-set absolute path
reuse    every attempt of that task
remove   on DELIVERED, on CANCELLED, or on explicit operator cleanup
keep     on FAILED — the worktree is evidence
```

The worktree root lives outside the repository deliberately. Placing it under
`.sch-loop/worktrees/` would put worker scratch space inside the control state
that workers are default-denied from reading, and would make the repository's own
clean-tree gate fight the containment mechanism.

Every project's worktrees share one root, so a worker that walks up two levels
can see other projects' worktrees. That is not prevented here — it is the same
unsolved "writes and reads outside the worktree" gap named in section 2, and it
is listed as such rather than argued away.

`git worktree prune` is never run automatically. A pruned worktree with
unapproved work in it is unrecoverable, and no scheduler decision is worth that.

## 4. Worker environment

The credential strip belongs in the **worker's environment**, never in the
worktree's git configuration. The delivery controller runs in that same worktree
and still has to authenticate a push.

Added to the worker environment:

```
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0=credential.helper
GIT_CONFIG_VALUE_0=
```

An empty value disables the configured `manager` helper for that process only.

Removed from the executor's environment allowlist for worker processes:
`GH_TOKEN`, `GITHUB_TOKEN`, `GIT_ASKPASS`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`.
`SCH_HOME` is already withheld and stays withheld.

`executor.mjs` already builds an allowlisted environment, so this is a list edit
plus one added configuration triple.

## 5. Branch and delivery

The delivery controller runs **unchanged**, inside the worktree, with `repoRoot`
set to the worktree path. Identical staging by explicit pathspec, identical
approval binding, identical secret gate, identical independent remote re-fetch.
This is the whole reason the worktree approach was chosen over copying content
back into the main tree: `computeCandidate({ repoRoot, ... })` and every git call
in the controller are already parameterized by a repository root.

### The branch-namespace authorization

`delivery.mjs:721` currently stops with `UPSTREAM_CHANGED`:

> `"<branch>" does not exist on "<remote>". Commit is created locally and NOT
> pushed — creating a remote branch is an explicit decision, not something SCH
> does on your behalf.`

Per-task branches hit that gate on every task's first push. A human gate per task
would destroy the autonomy this milestone exists to enable.

Resolution: a per-project, operator-set, revocable branch namespace.

```yaml
delivery:
  branch_namespace: "sch/task-*"
```

The `UPSTREAM_CHANGED` stop at `delivery.mjs:721` becomes conditional. If the
branch matches the project's authorized namespace, the first push may create the
remote branch and set upstream, and the delivery event records the namespace
authorization id that permitted it. A branch outside the namespace stops exactly
as it does today, with the same code and the same message.

The underlying principle — creating a remote branch is an explicit human
decision — is preserved. Its cost drops from one decision per task to one
decision per project.

### Integration

Task branches are left on the remote after delivery. The project branch does not
advance on its own. Integration back to the mainline is **not** part of this
milestone and is not implied by it.

This is a user-visible behavior change and must be documented as one: today's
delivery advances the working branch, and after this milestone it does not.

### Control state stays in the main repository

`WS.validateWorkspace({ projectId, repoPath })` returns `{ root, dir }` and three
call sites derive both from it: `runner.mjs:753` and `:984`, `scheduler.mjs:354`,
`delivery.mjs:288`. Today `root` (where work happens) and `dir` (where `.sch-loop`
control state lives) are necessarily the same directory.

This milestone **decouples them**:

```
wsDir     stays in the main repository — evidence, runs, decisions, handoffs
repoRoot  becomes the worktree — worker cwd, baseline, effect inspection, delivery
```

Without this, run evidence would be written into `.sch-loop/runs/` *inside a
disposable worktree* and deleted with it on DELIVERED. Evidence must outlive the
container it was produced in.

The worktree still contains its own tracked `.sch-loop/` files, inherited from the
branch. `WS.workerDenied` operates on paths relative to `repoRoot`, so the
default-deny of control state continues to fire inside the worktree unchanged.

## 6. Effect inspection

Two changes in `runner.mjs`:

- **Baseline is taken in the worktree.** The existing worktree count at
  `runner.mjs:210` and its comparison at `:291` must compare like with like.
  SCH's own worktree exists before the baseline is taken, so it is invisible to
  the check; a worktree the worker creates still trips `worktrees_changed`.
- **Containment re-points to the worktree root.** Today's path containment,
  including the absolute-path, `..` and symlink/junction escape refusals, is
  computed against `repoRoot`. `repoRoot` now *is* the worktree, so most of this
  is free, but the escape check must be re-derived from the worktree root rather
  than from the registered project path, and a path resolving outside that root
  is a forbidden effect.

## 7. Failure and recovery

- **Worktree present, task state says no run in flight.** Stale from an
  interrupted attempt. Adopt it. Do not delete it — it may hold unapproved work.
- **Worktree absent, task mid-attempt.** Hard failure, `NEEDS_DECISION`. Do not
  recreate it silently. The carried-forward work from the previous attempt is
  gone, and recreating the worktree would fabricate a baseline that never
  existed.
- **Worktree present but on the wrong branch, or with a divergent HEAD.**
  `NEEDS_DECISION`. Nothing is reset.
- **Reboot mid-task.** The worktree and its branch survive on disk. Phase
  persistence already tells the scheduler which phase it was in. No new recovery
  mechanism is needed.

## 8. Verification

Every item below is a test, and the first one is deliberately a test that
*fails to catch* something — recorded as a known gap so that silence is never
later mistaken for coverage.

- **Known gap:** a worker that writes a file outside the worktree root is not
  prevented, and post-run inspection does not see it. Asserted explicitly.
- A worker attempting `git push` fails, because no credential helper is
  available to it.
- The main working tree is byte-identical before and after a complete task,
  including delivery.
- A branch outside the authorized namespace still stops with `UPSTREAM_CHANGED`.
- A branch inside the namespace creates the remote branch on first push, sets
  upstream, and records the authorization id.
- Attempt 2 of a task sees attempt 1's uncommitted changes.
- A worker that creates its own worktree trips `worktrees_changed`.
- A worktree missing mid-attempt produces `NEEDS_DECISION` and does not recreate.

## 9. What this milestone does not do

Network restriction. Prevention of writes outside the worktree root. Prevention
of process escape by detaching into a new session. OS-level sandboxing. Docker or
second-user providers. Integration of task branches back to the mainline.
Parallel execution — the queue still runs one task at a time.

The worktree primitive introduced here is the same primitive the planned parallel
milestone needs, but nothing in this milestone runs two tasks at once.
