# SCH-LOOP Project Configuration

owner: SCH-LOOP
loop: sdlc
autonomous_mode: enabled
user_control_word: go
state_file: .sch-loop/state.json
task_file: task.md
roles_file: .sch-loop/roles.json
engine: .claude/sch
transport: herdr
executor_permission: bypass
max_code_executors: 1
max_executor_attempts: 3
max_review_rounds: 3
council_mode: gated
council_minimum_seats: 2
context_soft_limit: 100000
context_hard_limit: 130000
require_tdd_for_behavior_changes: true
require_independent_review: true
require_fresh_evidence: true
timeouts_minutes: { XS: 5, S: 15, M: 30, L: 60 }
silence_nudge_seconds: 120
rate_limit_backoff_minutes: [1, 2, 4, 8]
protected_paths:
  - .sch-loop/private/**
  - .claude/sch/**
  - .claude/hooks/**
  - .env*
  - "**/*.pem"

## Notes

- Bypass mode starts only when all three fences hold: worktree + write-outside detection, write-guard hook, destructive-bash hook.
- Council is gated: architecture approval, plan approval, `council:true` tickets, two consecutive reds on one ticket, phase-verify failure.
- `go` authorizes routine continuation inside approved scope; never destructive ops, credentials, or scope expansion.
- Engine paths resolve to `$CLAUDE_PROJECT_DIR/.claude/sch/`, never `~/.claude`.
