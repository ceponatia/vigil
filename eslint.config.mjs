import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import nextPlugin from "eslint-config-next";
import globals from "globals";
import tseslint from "typescript-eslint";

// A workspace package publishes the entry points its `exports` map declares
// (today: only its root, `.`) and nothing else. `src/` is always internal.
const RESTRICT_PACKAGE_INTERNALS = {
  group: ["@vigil/*/src/*", "@vigil/*/src/**"],
  message:
    "src/ is a workspace package's internals, never its API. Import the package's root (@vigil/<name>) or a subpath its exports map declares.",
};

// Adapters hold venue credentials and the ability to place a real order —
// the layer graph lets only apps/trading wire one in
// (docs/architecture.md "Layer graph and import rules").
const RESTRICT_ADAPTERS = {
  group: ["@vigil/adapter-*"],
  message:
    "Only apps/trading may import an adapter-* package: adapters hold venue credentials and execution authority (docs/architecture.md \"Layer graph and import rules\").",
};

// LLMs generate research and proposals; they never sit on the money path
// (product rule 1). Provider SDKs are confined to the research app's model
// gateway, which does not exist yet — this ban is pre-declared so the day
// apps/research lands, no other module has quietly taken a dependency on a
// provider SDK in the meantime.
const RESTRICT_LLM_PROVIDERS = {
  group: ["openai", "@anthropic-ai/sdk", "@openrouter/ai-sdk-provider", "@ai-sdk/*", "ai"],
  message:
    "LLM provider SDKs are confined to the research app's model gateway; no other module may construct or call a provider directly (docs/architecture.md \"Layer graph and import rules\").",
};

// Packages sit below apps in the layer graph and never import one, whether
// by workspace name or by climbing out via a relative path
// (docs/architecture.md "Layer graph and import rules").
const RESTRICT_APPS_FROM_PACKAGES = [
  {
    group: ["@vigil/control", "@vigil/trading"],
    message: "Packages never import an app; the layer graph runs one way (docs/architecture.md \"Layer graph and import rules\").",
  },
  {
    regex: "^\\.\\.(/\\.\\.)*/apps(/|$)",
    message: "Packages never import an app by path either — the same rule as importing it by name.",
  },
];

// apps/control ← {contracts, db, policy} only: the dashboard reads the
// database and issues commands, and nothing else about the trading domain
// (docs/architecture.md "Layer graph and import rules"). market/ledger/strategies
// are named individually here; adapter-* is already covered by
// RESTRICT_ADAPTERS above.
const RESTRICT_CONTROL_PACKAGES = {
  group: ["@vigil/market", "@vigil/ledger", "@vigil/strategies"],
  message:
    "apps/control may depend only on @vigil/contracts, @vigil/db, and @vigil/policy among workspace packages (docs/architecture.md \"Layer graph and import rules\").",
};

const NAMING_CONVENTION = [
  "error",
  { selector: "default", format: ["camelCase"], leadingUnderscore: "allowDouble", trailingUnderscore: "allow" },
  { selector: "variable", format: ["camelCase", "UPPER_CASE", "PascalCase"], leadingUnderscore: "allowDouble" },
  { selector: "function", format: ["camelCase", "PascalCase"] },
  { selector: "parameter", format: ["camelCase", "PascalCase"], leadingUnderscore: "allow" },
  { selector: "typeLike", format: ["PascalCase"] },
  { selector: "enumMember", format: ["PascalCase", "UPPER_CASE"] },
  { selector: "import", format: null },
  // Object/type keys frequently mirror external shapes (JSON APIs, DB columns).
  { selector: ["objectLiteralProperty", "typeProperty"], format: null },
];

// Money and quantities are decimal strings on the wire and exact integer
// base units or a decimal type internally — never IEEE-754 float (product
// rule 5). `parseFloat` is the most common way that rule gets broken by
// accident, so it is banned everywhere the numbers it would parse are real
// money: the four pure packages that compute with money or quantities, the
// trading runtime that authorizes and executes it, and packages/db, which
// reads every base-unit column back as a `numeric` — a string, and so one
// `parseFloat` away from a balance that no longer reconciles.
const MONEY_GUARD_FILES = [
  "packages/contracts/**/*.{ts,tsx}",
  "packages/db/**/*.{ts,tsx}",
  "packages/ledger/**/*.{ts,tsx}",
  "packages/policy/**/*.{ts,tsx}",
  "packages/strategies/**/*.{ts,tsx}",
  "packages/market/**/*.{ts,tsx}",
  "apps/trading/**/*.{ts,tsx}",
];
const MONEY_GUARD_MESSAGE = "money and quantities are decimal strings or integer base units; see docs/resilience.md";

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    "**/.next/**",
    "drizzle/**",
    "coverage/**",
    "eslint.config.mjs",
    ".claude/**",
    ".codex/**",
    ".agents/**",
    "data/**",
    "eval-output/**",
    "private/**",
  ]),

  js.configs.recommended,

  // eslint-config-next's rules resolve pages/app conventions relative to
  // `settings.next.rootDir`; scoping it with `extends` + `files` keeps it
  // from ever evaluating apps/trading or a workspace package as if it were
  // the Next.js application.
  {
    files: ["apps/control/**/*.{ts,tsx}"],
    extends: [nextPlugin],
    settings: { next: { rootDir: "apps/control" } },
  },

  // ---------------------------------------------------------------------------
  // Type-aware guardrails (whole repo). These encode the failure modes an
  // agent-written financial codebase cannot afford: `any` escape hatches,
  // dropped awaits, suppressed errors, unhandled union variants.
  // (Circular-dependency detection lives in `pnpm lint:cycles` / madge, not
  // here — it re-resolves the whole module graph per file and is far cheaper
  // as a single dedicated pass.)
  // ---------------------------------------------------------------------------
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // Type-safety escape hatches.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description", "ts-ignore": true, "ts-nocheck": true },
      ],
      // Async correctness.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
      // Exhaustiveness over discriminated unions (operating modes, order
      // lifecycle states, reason codes).
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // Consistency / drift.
      "@typescript-eslint/consistent-type-imports": ["error", { disallowTypeAnnotations: false }],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/naming-convention": NAMING_CONVENTION,
    },
  },

  // ---------------------------------------------------------------------------
  // Module-boundary enforcement (docs/architecture.md "Layer graph and
  // import rules"). Disjoint file globs → each file resolves to exactly ONE
  // no-restricted-imports config: flat config replaces a rule's value
  // wholesale on a second match rather than merging it, so an overlapping
  // second block would silently drop the first block's patterns.
  // ---------------------------------------------------------------------------

  // 1. packages/**: internals ban + adapter isolation + LLM-gateway isolation
  //    + "packages never import an app" (docs/architecture.md "Module
  //    dependency rules").
  {
    files: ["packages/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [RESTRICT_PACKAGE_INTERNALS, RESTRICT_ADAPTERS, RESTRICT_LLM_PROVIDERS, ...RESTRICT_APPS_FROM_PACKAGES] },
      ],
    },
  },

  // 2. apps/trading: everything is available (layer graph: apps/trading ←
  //    everything, docs/architecture.md "Layer graph and import rules") except
  //    package internals and a direct LLM provider dependency — the trading
  //    runtime is deterministic and never holds an LLM key (product rule 1).
  {
    files: ["apps/trading/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [RESTRICT_PACKAGE_INTERNALS, RESTRICT_LLM_PROVIDERS] }],
    },
  },

  // 3. apps/control: internals ban + adapter isolation + LLM-gateway
  //    isolation + the narrowed package surface {contracts, db, policy}
  //    (docs/architecture.md "Layer graph and import rules"). The dashboard reads
  //    the database and issues commands; it never touches execution.
  {
    files: ["apps/control/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [RESTRICT_PACKAGE_INTERNALS, RESTRICT_ADAPTERS, RESTRICT_LLM_PROVIDERS, RESTRICT_CONTROL_PACKAGES] },
      ],
    },
  },

  // 4. Reserved for apps/research/** once it exists: internals ban + adapter
  //    isolation apply there too, but NOT the LLM-provider ban — a model
  //    gateway is the one place a provider SDK is allowed
  //    (docs/architecture.md "Layer graph and import rules"). Matches zero files
  //    today; pre-declared so nobody has to remember to carve out this
  //    exception when the app is created.
  {
    files: ["apps/research/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [RESTRICT_PACKAGE_INTERNALS, RESTRICT_ADAPTERS] }],
    },
  },

  // 5. Everything else with TypeScript source — tests/, scripts/, and
  //    root-level *.ts config — gets the full set: internals ban, adapter
  //    isolation, and LLM-gateway isolation (docs/architecture.md "Module
  //    dependency rules").
  {
    files: ["tests/**/*.ts", "scripts/**/*.ts", "*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [RESTRICT_PACKAGE_INTERNALS, RESTRICT_ADAPTERS, RESTRICT_LLM_PROVIDERS] },
      ],
    },
  },

  // Money guard (docs/resilience.md): money is never floating point
  // (product rule 5). `parseFloat`/`Number.parseFloat` are the two spellings
  // of the same mistake.
  {
    files: MONEY_GUARD_FILES,
    rules: {
      "no-restricted-globals": ["error", { name: "parseFloat", message: MONEY_GUARD_MESSAGE }],
      "no-restricted-properties": [
        "error",
        { object: "Number", property: "parseFloat", message: MONEY_GUARD_MESSAGE },
      ],
    },
  },
]);
