# GUI resilience and large-session plan

1. Fix a new goal inheriting the completed status of its predecessor; cover
   completed → new active goal in the session and GUI.
2. Bound outgoing agent protocol queues, honour stream backpressure, reject
   blocked/disconnected writes and distinguish transport failure from RPC timeout.
3. Recover the renderer after a crash with saved panel state and explicit session
   status, while protecting terminals and avoiding automatic crash/reload loops.
4. Load persisted artifact metadata first; hydrate only a requested artifact or
   revision, preserving references on save and checksum/account validation.
5. Reduce off-screen history rendering without losing browser find, selection,
   scroll position or keyboard/accessibility behaviour; measure the real GUI.
6. Share modal keyboard/focus lifecycle (topmost Escape, Tab containment and
   focus restoration), including worktree dialogs and existing modal variants.
7. Add a repeatable isolated GUI workload with a long conversation, many
   artifacts and terminals; record opening time, memory and input latency.

Each change needs targeted regression coverage. Finish with typecheck/lint,
production/test builds, full unit tests and headless GUI tests. Tests must not
open an external browser. Commit verified work locally.
