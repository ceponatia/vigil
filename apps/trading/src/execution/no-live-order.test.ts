import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PAPER_ADAPTER_CAPABILITY } from "@vigil/adapter-paper";

import { refuseNonPaperAdapter, type DeclaredAdapterCapability } from "./dispatch";

/**
 * The defect this file kills: an execution domain that grows a second way to
 * reach a venue.
 *
 * Nothing the type system or the linter checks can tell "this runtime
 * dispatches to a simulation" from "this runtime has a live client that
 * happens to be unwired today", and an unwired client is one configuration
 * flag away from a wired one. Issue #35's criterion is about the code as
 * written — no code path constructs a live order or a signing request, and
 * only `adapter-paper` is reachable — so this suite reads the execution
 * domain's own source and asserts the constructs are absent rather than
 * disabled.
 *
 * It also pins the structural form of "every dispatch path runs a fresh
 * pre-dispatch check": `submitOrder` is called from exactly one place, and
 * that place takes a `DispatchClearance` only `revalidateBeforeDispatch` can
 * produce. A second call site would be a second way to reach the venue
 * without a gate, and it has to edit this file to exist.
 *
 * Deliberately crude, like `@vigil/adapter-paper`'s own equivalent. A
 * determined author evades any token list; the point is that adding one of
 * these has to be a deliberate act that also edits this file, which is the
 * review moment that should exist.
 */

const EXECUTION_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Network, remote-endpoint and signing-material constructs. */
const FORBIDDEN_CONSTRUCTS = [
  "fetch(",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "node:http",
  "node:https",
  "node:net",
  "node:tls",
  "node:dgram",
  "node:child_process",
  "axios",
  "undici",
  "node-fetch",
  "http://",
  "https://",
  "apiKey",
  "apiSecret",
  "privateKey",
  "mnemonic",
  "seedPhrase",
  "signTransaction",
] as const;

/** The only adapter this application may wire in for this slice. */
const PERMITTED_ADAPTER = "@vigil/adapter-paper";

const ADAPTER_IMPORT = /from "(@vigil\/adapter-[^"]+)"/g;

/** Excluded because the token list below necessarily contains every construct it looks for. */
const SELF = "no-live-order.test.ts";

function executionFiles(): readonly string[] {
  return readdirSync(EXECUTION_DIR, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(SELF))
    .map((entry) => join(EXECUTION_DIR, entry));
}

/** Production source only: no suite, no fixture. */
function productionFiles(): readonly string[] {
  return executionFiles().filter((file) => !file.includes(".test.") && !file.includes("test-support"));
}

describe("the execution domain reaches no endpoint and signs nothing", () => {
  it("has source files to check at all", () => {
    // Without this, a scan that silently found nothing would pass every
    // assertion below by vacuity.
    expect(productionFiles().length).toBeGreaterThan(5);
  });

  it("contains no network or signing construct, in production source or in its own suites", () => {
    const findings: string[] = [];
    for (const file of executionFiles()) {
      const contents = readFileSync(file, "utf8");
      for (const construct of FORBIDDEN_CONSTRUCTS) {
        if (contents.includes(construct)) {
          findings.push(`${file}: ${construct}`);
        }
      }
    }
    expect(findings).toEqual([]);
  });

  it("imports no adapter but the paper one", () => {
    const imported = new Set<string>();
    for (const file of executionFiles()) {
      for (const match of readFileSync(file, "utf8").matchAll(ADAPTER_IMPORT)) {
        const specifier = match[1];
        if (specifier !== undefined) {
          imported.add(specifier);
        }
      }
    }
    expect([...imported].filter((specifier) => specifier !== PERMITTED_ADAPTER)).toEqual([]);
  });

  it("reads no environment variable in production source — the execution domain takes its configuration as arguments", () => {
    const findings = productionFiles().filter((file) => readFileSync(file, "utf8").includes("process.env"));
    expect(findings).toEqual([]);
  });

  it("calls submitOrder from exactly one place, so no dispatch path can skip the pre-dispatch gate", () => {
    const callSites = productionFiles().flatMap((file) => {
      const occurrences = readFileSync(file, "utf8").split("submitOrder(").length - 1;
      return occurrences > 0 ? [`${file}: ${String(occurrences)}`] : [];
    });
    expect(callSites).toHaveLength(1);
    expect(callSites[0]?.endsWith(": 1")).toBe(true);
    expect(callSites[0]).toContain("dispatch.ts");
  });
});

describe("refuseNonPaperAdapter", () => {
  it("admits the paper adapter's own declared capability", () => {
    expect(refuseNonPaperAdapter(PAPER_ADAPTER_CAPABILITY)).toBeNull();
  });

  it("refuses an adapter that claims any live capability, whichever one it claims", () => {
    // Built against `DeclaredAdapterCapability` rather than the paper
    // adapter's own type, and that is the point of the wider parameter: an
    // `AdapterCapability` types these three as the literal `false`, so a
    // capability claiming one could not be constructed here without casting
    // the guarantee away — and three of the four checks would be branches the
    // compiler had already proved unreachable.
    const paper: DeclaredAdapterCapability = {
      adapterId: PAPER_ADAPTER_CAPABILITY.adapterId,
      mode: PAPER_ADAPTER_CAPABILITY.mode,
      reachesLiveEndpoint: PAPER_ADAPTER_CAPABILITY.reachesLiveEndpoint,
      holdsVenueCredential: PAPER_ADAPTER_CAPABILITY.holdsVenueCredential,
      canSignTransactions: PAPER_ADAPTER_CAPABILITY.canSignTransactions,
    };
    const claims: ReadonlyArray<Partial<DeclaredAdapterCapability>> = [
      { reachesLiveEndpoint: true },
      { holdsVenueCredential: true },
      { canSignTransactions: true },
      { mode: "LIVE" },
    ];

    for (const claim of claims) {
      const refusal = refuseNonPaperAdapter({ ...paper, ...claim });
      expect(refusal).not.toBeNull();
      expect(refusal?.reason).toEqual({ source: "execution", code: "ADAPTER_NOT_PAPER" });
    }
  });
});
