# Canvas Atelier project working rules

Before changing this repository, read `docs/project-memory.md` completely and inspect the current dirty worktree. Preserve every unrelated uncommitted change.

For every bug fix:

1. Reproduce the current behavior and identify the actual cause before editing production code.
2. Add or update a regression test that fails for that cause.
3. Make the smallest compatible implementation change.
4. Run the focused regression tests, then the relevant wider suite.
5. Update `docs/project-memory.md` with the root cause, protected behavior, test location, and verification command.
6. Do not claim a fix or create an installer until fresh verification passes.

Do not restore an older CSS override or persistence path merely because it makes one screenshot look correct. Check the final cascade order, node boundaries, autosave identity, and packaged runtime behavior.

