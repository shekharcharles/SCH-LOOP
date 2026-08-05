# ADR 0004 — Contain the worker before handing it a phone and a daemon

**Status:** accepted · Narrows ADR 0003's "what is NOT true yet" · Precedes the
authenticated control plane and the supervisor daemon
**Date:** 2026-08-05

## Context

ADR 0003 ended by recording that workers are not OS-sandboxed: they ran as the
operator, **in the operator's working tree**, with the operator's `PATH` and with
`credential.helper = manager` one `git push` away. It concluded that fully
unattended operation is not supported, and that conclusion was correct.

It was also the thing blocking everything worth building next. An authenticated
control plane, a supervisor daemon that keeps going, and a phone that can steer
it all mean the same sentence: *SCH acts while nobody is watching*. Building any
of them on an uncontained worker is building a remote trigger for a process that
holds your credentials.

## Decision

```text
The worker gets its own checkout, no credentials, and no way to publish.
```

Three mechanisms, each independently testable:

**A disposable worktree per task.** `git worktree add <root>/<project>/<task> -b
sch/task-<n> <base>` on task claim, where `<root>` is outside the managed
repository and outside `SCH_HOME`. One worktree per *task*, not per attempt, so
ADR 0003's guarantee — a retry inherits the previous attempt's uncommitted work
rather than discarding it — survives. Removed on DELIVERED or CANCELLED, **kept
on FAILED**, because a failed worktree is evidence. `git worktree prune` is never
run automatically: a pruned worktree with unapproved work in it is unrecoverable,
and no scheduler decision is worth that.

**Credentials stripped from every bounded child.** `credential.helper` is emptied
for the child process via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/
`GIT_CONFIG_VALUE_0`, and `GH_TOKEN`, `GITHUB_TOKEN`, `GIT_ASKPASS`,
`SSH_AUTH_SOCK` and `SSH_AGENT_PID` leave the environment allowlist. This applies
to the **verification commands as well as the worker** — a task's `--verify` is
usually `npm test` and the worker wrote those test files, so a credential
reachable through the test command is not stripped at all. The strip lives in the
environment, never in the worktree's git config, because the delivery controller
runs in that same worktree and still has to authenticate a push.

**Namespace authorization for branch creation.** Creating a remote branch stayed
an explicit operator decision; the decision moved from once per task to once per
project, over a pattern: `delivery-branch-namespace --set "sch/task-*"
--approver <you>`. Outside that namespace the controller stops exactly as it
always did.

## Alternatives rejected, and why each was deferred

- **Docker.** The strongest boundary by construction — no host filesystem, no
  credential vault, controllable network. Deferred because each managed project
  needs an image capable of running that project's own build and test commands,
  and bind-mounting a repository from `D:` is slow. It remains the right second
  provider.
- **A second Windows local user.** A real kernel boundary with no new dependency,
  and the DPAPI-bound credential vault becomes genuinely unreachable. Deferred
  because `claude` is installed per-user under `nvm4w`, so the worker account has
  neither node nor the CLI; it would need its own Claude login; and launching a
  process as another user from Node requires a service or a scheduled task.
- **WSL2 with a dedicated Unix user.** Deferred because managed repositories live
  on `D:`, and `/mnt/d` has no real permissions and poor I/O. Moving repositories
  into the WSL filesystem is a larger change than this milestone.
- **Blast-radius reduction.** Selected. Roughly a tenth of the cost of the
  others, delivers most of the unattended value, and leaves the strong providers
  available later.

## Consequences

**Commits land on task branches.** Work happens on `sch/task-<n>` and is
delivered there. `main` no longer advances on its own — nothing in SCH merges,
rebases or fast-forwards a mainline, and nothing here started to.

**Integration is a later milestone.** Getting `sch/task-<n>` back into a mainline
is a person's job today. Fan-out/fan-in, deterministic integration nodes and
conflict-safe joins remain unbuilt.

**A first push measures against the remote base.** Until the task branch exists
on the remote, "outgoing" means what it adds on top of `<remote>/<base branch>`.
Unpushed local commits on that base branch are inside the range, so the delivery
stops with `UNRELATED_OUTGOING_COMMITS` naming commits from another task. That is
the fail-closed rule behaving correctly, and it is documented in the README
because no operator would guess it.

**Effect inspection had to learn about linked worktrees.** A linked worktree's
private git dir holds HEAD and little else; config, packed refs and hooks live in
the shared common dir. Fingerprinting the private dir made all three hash as
"absent" both before and after — the hook check would have gone blind in exactly
the configuration every worker now runs in.

## What is still NOT true

A write outside the worktree is neither prevented nor detected. The network is
unrestricted. A process that detaches into a new session survives the tree-kill.
The credential strip removes the *ambient* helper and does not stop a worker that
deliberately re-adds one with `git -c credential.helper=…` or `git config
--local`. All projects share one worktree root, so a worker walking up two levels
can see other projects' worktrees. None of this is OS-level sandboxing.

Therefore **fully unattended operation is still not supported**. This milestone
narrows the blast radius; it is not isolation, and the authenticated control
plane and supervisor daemon inherit every one of these caveats.

The first of those gaps is asserted, as a gap, in `tests/containment.test.mjs`.
When it closes, that test fails and the README has to be corrected — which is the
point of writing it down as a test instead of a sentence.
