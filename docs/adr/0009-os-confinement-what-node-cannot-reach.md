# ADR 0009 — The OS boundary SCH cannot build, and the one it already has

**Status:** accepted · Answers ADR 0004's and ADR 0007's deferred "only an OS
boundary fixes that" · Records a **negative result**
**Date:** 2026-08-06

## Context

Three ADRs now end with the same sentence in different words. ADR 0004: *none of
this is OS-level sandboxing.* ADR 0007: *nothing is prevented; the worker still
runs as the operator with the operator's PATH.* The README says it in one line —
**"Workers are not OS-sandboxed. They run as your user with your PATH."** — and
calls it the largest remaining containment gap.

Before that line can be narrowed it has to be tested rather than repeated. The
question this ADR answers is narrow and answerable: **with no new dependencies,
no native modules, and no Administrator rights, what OS-level confinement can
Node actually reach?**

Every claim below was measured on the target platform (Windows 11 Pro 26200,
Node 24.5.0) rather than recalled. **The measuring shell was elevated**, which is
recorded because it changes how two results read, and both are noted where they
occur. No result depends on having had Administrator rights: nothing below
*succeeded* because of elevation.

## Decision

```text
There is no OS boundary here to build. Record what was tested, keep the one
boundary the OS already gives for free, and harden the half of the README
sentence that does not need the kernel: the PATH.
```

### What was tested, and what it did

**1. Windows Job Objects — already present, not configurable, and not a security
boundary anyway.**

Measured: a Node process spawned a child; killing *only* the Node process
(`Stop-Process -Force` — no tree walk, no `/T`) killed the child too. The same
probe with `detached: true` left the child alive.

| grandchild | SCH-side process killed with no tree walk | grandchild after |
| --- | --- | --- |
| `detached: false` | yes | **dead** |
| `detached: true`  | yes | alive |

The mechanism is a Windows Job Object with kill-on-close, and it is libuv's own
rather than one inherited from whatever launched SCH. That distinction matters —
an inherited job would make the property an accident of how SCH was started — so
it was reasoned to rather than assumed. `IsProcessInJob` reports **every**
process here as being in some job, the shell included, so job membership alone
proves nothing. What settles it is the kill: a job dies when its **last handle**
closes, and a job inherited from the launching shell is still held by that shell,
so killing Node could not have closed it. The child died anyway. The only job
whose last handle closed when Node died is a job Node itself created. The
`detached` row is the confirmation from the other side: libuv assigns each child
it spawns to that job and skips the assignment for a detached one, which is
exactly the split observed.

So SCH already has one real OS-enforced property on Windows, inherited rather
than built: **if SCH dies, its bounded children die with it** — no cleanup code,
no cooperation, no window in which SCH must still be alive to tidy up. It exists
solely because `spawn` is called with `detached: process.platform !== "win32"`,
which is `false` on win32. Nothing asserted that. It does now.

Setting job *limits* (process count, committed memory, CPU rate) is a different
matter: `CreateJobObject`/`SetInformationJobObject` have no Node binding, and
`node:child_process` exposes no option that reaches them. The only route without
a compiled addon is `powershell.exe -Command Add-Type` compiling a C# P/Invoke
shim at run time — verified to work on this machine, and rejected: that is a
native module wearing a trenchcoat, it needs a .NET compiler present and
FullLanguage mode, and it makes `powershell.exe` the process host that owns the
job handle, which costs the stdin prompt, the exit code and the kill guarantee.

And it would not close the gap regardless. **A job object is a resource
governor, not a confinement boundary.** It caps how much a worker can consume;
it does not touch the filesystem, the network, the credential vault, or the user
identity the README sentence actually names. Building it would look like
progress on a gap it cannot move.

**2. A lower-privilege token — reachable, and unusable.**

`runas /trustlevel:0x20000` ("Basic User") ships with Windows, needs no password
and no Administrator rights, and genuinely produces a restricted token: the child
reported `BUILTIN\Administrators — Group used for deny only`. (That particular
line is an artefact of the elevated measuring shell — from a standard account
there is no Administrators membership to deny. The timing result below is not.)

It is also fire-and-forget. Measured against a child that sleeps four seconds and
exits 42:

| property | value |
| --- | --- |
| `runas` returned after | **138 ms** (child still running) |
| exit code reported | **0** (child exited 42) |
| stdout captured | **empty** |
| process handle for the caller | **none** |

Adopting it would trade *every* guarantee `scripts/subprocess.mjs` exists to
provide — bounded output, real exit code, timeout, cancellation, process-tree
kill — for a token with `Administrators` marked deny-only, on a machine where the
worker is not an Administrator to begin with. Everything stronger
(`CreateRestrictedToken`, a low-integrity token, an AppContainer, a second user
account) needs Win32 calls Node cannot make, a password, or a service.

**3. Filesystem ACLs against the same user — a speed bump, not a boundary.**

`icacls <dir> /deny "<me>:(OI)(CI)(W)"` did block the write
(`UnauthorizedAccessException`). The same user then removed the ACE with one
command (`icacls /remove:d`, exit 0) and wrote successfully. A principal that can
rewrite the DACL is not confined by it, and a worker running as the operator can
always rewrite it. Shipping this as containment would be a false claim.

The directory's owner in that probe was `BUILTIN\Administrators`, because an
elevated shell created it. The conclusion does not turn on that: a
non-elevated operator owns the directories in question outright, and an owner
holds `WRITE_DAC` implicitly. Either way the ACE comes off.

**4. POSIX rlimits — no API, and the wrapper costs more than the bound.**

`process.setrlimit` and `process.getrlimit` are `undefined`; the only related
surface Node exposes is `process.umask`, which controls the *mode of files a
process creates*, not what it can reach, and is process-wide rather than
per-child. Reaching `setrlimit` means `sh -c 'ulimit …; exec …'`, which
contradicts `subprocess.mjs`'s load-bearing invariant — *there is no shell,
ever*. The two bounds worth having are wrong anyway: `ulimit -u` is per-**user**
on Linux and would count the operator's own processes, and `ulimit -v` breaks
V8, which reserves address space far beyond what it commits. Process groups, the
one POSIX mechanism that does apply, are already used for the tree kill.

**5. The PATH — the half of the sentence that does not need the kernel.**

`buildEnv` allowlists the environment, and `PATH` is on the allowlist verbatim.
It is the only allowlisted value that names places to load **executable code**
from, and a non-absolute entry in it is resolved against the **child's** working
directory. For a verification command that directory is the worktree the worker
just finished writing.

Measured (Windows, libuv): a bare executable name is **not** searched for in the
child's cwd, and an **empty** PATH entry is ignored — but a literal `.` **is**
honoured and resolved against the child's cwd. `resolveExecutable` had the same
exposure one level up: it joins each PATH entry with the command name and stats
it, so a relative entry resolves against SCH's own cwd, the managed repository.

That one is fixable here, so it was fixed: **`buildEnv` and `resolveExecutable`
now keep absolute PATH entries only.**

## Consequences

- **Two lines of genuine hardening, described as exactly what they are.** A
  worker can no longer turn a file it wrote into something SCH's next command
  runs by name. That closes one path from worker *output* to SCH *input*. It is
  not isolation and must never be described as isolation.
- **An operator with a relative directory on PATH loses it inside SCH's
  children.** `PATH=node_modules/.bin:$PATH` is a real pattern; inside SCH it
  stops resolving. That is the intended behaviour change, in precisely the case
  that made it dangerous.
- **The free orphan kill is now pinned by a test** that kills the SCH-side
  process with no tree walk and asks the OS what survived. Flip `detached` to
  `true` on win32 "for symmetry with POSIX" and that test fails.
- **The asymmetry is now on the record.** POSIX has no equivalent of the libuv
  job object *reachable from Node*: `detached: true` there is required for the
  process-group kill, and it means a worker survives an SCH crash. Linux's
  `PR_SET_PDEATHSIG` and cgroups would apply, and neither has a binding. Closing
  that needs a supervisor, not a flag.
- **No further OS work is planned at this layer.** The next real boundary is a
  container or a second account, both of which ADR 0004 already deferred with
  reasons that still hold. Nothing in this ADR brings them closer, and nothing in
  it should be mistaken for a down payment on them.

## What is still NOT true

Workers are still not OS-sandboxed. They run as the operator, with the
operator's file access, the operator's network and — apart from the entries that
could never have been legitimate — the operator's PATH. Nothing here prevents a
write, a read, a network call, or a process. A worker that spawns detached
escapes even the free orphan kill.

**A real boundary needs a container, a second user account, or a native module,
and all three were priced in ADR 0004 and deferred.** Until one of them exists,
fully unattended operation is not supported, and every containment claim in this
project remains blast-radius reduction with detection — not isolation.
