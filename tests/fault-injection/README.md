The fault scenario matrix described in `docs/testing.md` — crash mid-write,
duplicate delivery, stale data, partial fill, and similar cases the system
must fail closed on; see `tests/README.md` for naming and how the root
Vitest config selects these.
