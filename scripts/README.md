# scripts/

Repository guard scripts. None exists yet — this file lists what is
planned and the root script each one will back. A script's root
`package.json` entry is added in the same change that adds the script file;
until then, the corresponding root script does not exist.

## Planned

- **`check-workspace-imports`** → root script `lint:package-boundaries`.
  Proves every workspace import resolves to a declared `exports` entry
  point and respects the layer graph (`docs/architecture.md` "Module
  dependency rules") — the authoritative check behind the editor-latency
  `no-restricted-imports` rules in `eslint.config.mjs`.
- **`check-docs.mjs`** → root script `lint:docs`. A dependency-free Node
  script (no workspace install required to run it) that checks internal
  links, section citations against the files they cite, and retired names
  that should no longer appear in `docs/`.
- **`check-no-secrets`** → root script `lint:secrets`. Scans fixtures, logs,
  and docs for key-shaped strings (see `.gitignore`'s secret-shape patterns)
  and for personal-holdings data that must never leave the private handoff.
- **A migration runner**, only if `drizzle-kit migrate` proves insufficient
  for a case it needs to handle — not added speculatively ahead of that need.

## Status

Empty. No script exists yet.
