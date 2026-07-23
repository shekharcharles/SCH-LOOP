<!-- SCH Loop method body for domain: tool-dev. Same engine as app-dev; different validate + deliver. -->

# Tool development — method body

Build one feature task at a time from the PRD-derived queue. Same contract
discipline as app-dev.

- **Build:** dispatch to `python-project-structure` / `python-packaging` /
  `modern-python` / `python-testing-patterns` for Python, `rust-async-patterns`
  for Rust, `bash-defensive-patterns` for shell tools.
- **Validate:** run the tool for real — exercise the CLI/library against the
  task's `AC-N` (invoke the command, assert output/exit code). A CLI has no
  browser; Playwright does not apply. Keep the run transcript as evidence.
- **Review:** fresh `/sch-review` subagent against the AC.
- **Complete:** merge the branch to default; task → merged.
- **Deliver (sch-ship):** build the distributable (wheel / sdist / crate /
  binary), run the full test suite, tag a release. Publish to the registry
  (PyPI / crates.io / a GitHub release) only via the project's established path;
  otherwise produce the artifact and hand the publish step to the user.
