# Lessons

- A RED test whose assertion can be satisfied by an unrelated failure is not evidence → assert the specific failure code, and check the RED output names the failure your change will actually fix.
- A shared test fixture that writes to a machine-global path (LOCALAPPDATA, XDG_STATE_HOME) collides between tests and litters the operator's disk → give every fixture its own root through the env var the code already reads, and delete it in teardown.
- Before threading a new "where the work happens" root through a pipeline, grep every consumer of the old root in that pipeline — the ones you miss fail as drift or mismatch far downstream, not at the call you changed.
- "These N failures are all one cause" is a hypothesis, not a finding → fix the cause, re-run the whole set, and expect a second cause hiding behind the first in tests whose assertions encode the old world.
- A test that constructs a state a state machine must be able to reach → derive the route from the transition table and the resume predicate before writing the assertion, not from what the state "obviously" should be after a run.
- A test whose precondition depends on a host capability (symlink creation, admin rights, a binary being installed) → construct the precondition deterministically instead (git plumbing, a fixture), or it passes vacuously on the machine that lacks it and hides the bug it was written to catch.
- Guarding a repository property by asking the FILESYSTEM → ask git's index instead (`ls-files -s` modes); `core.symlinks=false` is the Windows default and materialises a symlink as a plain file, so an lstat-based guard is inert on the platform the engine runs on.
