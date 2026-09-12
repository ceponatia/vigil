# Existing helper lookup

Read this before writing test setup, fixtures, fake adapters, database
cleanup, or registry checks.

No shared test helper exists yet — this is a new repository with no prior
suites to search. Before adding one:

1. Search the nearest existing suite in the same package or app for a fixture
   or setup shape close to what you need; do not create a second helper for
   the same shape.
2. Check where a helper of this kind will live once it exists:
   - Cross-package synthetic fixtures — market snapshots, evidence records,
     sample intents, fake wallet/venue identities that are not real addresses
     or credentials: `tests/fixtures/`.
   - A package-local fixture, builder, or fake dependency used only within one
     package's own suites: that package's `src/test-support/` directory,
     imported relatively within the package.
   - A cross-package fake provider or adapter (a fake evidence/research
     gateway, a fake venue client) that more than one package's tests need:
     `tests/fixtures/` if it is pure data, or a declared export of the owning
     package (for example `packages/adapter-paper`) if it is behavior.
3. Add a helper only when at least two tests would otherwise duplicate the
   same setup. Keep one-off setup beside its test.
4. Fixtures never contain personal holdings, real credentials, real wallet
   addresses, or any content from the private project handoff's appendices —
   see the repository root rules. A synthetic wallet, key, or account
   identifier must be obviously fake, never a real one with digits redacted.

Production code must not import a package's `src/test-support` directory;
keep it reachable only from that package's own test files. Cross-workspace
fixtures use declared package exports rather than filesystem escapes.
