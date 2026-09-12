The fault scenario matrix described in `docs/testing.md` — crash mid-write,
duplicate delivery, stale data, partial fill, and similar cases the system
must fail closed on; see `tests/README.md` for naming and how the root
Vitest config selects these.

A scenario belongs here when its claim is about what survives a failure or a
race, and it uses the real infrastructure the failure needs: the
concurrent-reservation scenario drives two independent Postgres connections
at one balance, because a lock the second transaction must wait on is the
only thing that can prove two strategies cannot spend the same funds.
