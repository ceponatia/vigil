import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * The defect this file kills: a paper adapter that grows a real client.
 *
 * Nothing the type system or the linter checks can see the difference
 * between "this adapter simulates a venue" and "this adapter has an HTTP
 * client that happens to be unused today", and an unused client is one
 * config flag away from being a used one. Issue #33's criterion is about
 * the code as written — no code path in this package constructs a request
 * to a live order or signing endpoint — so this suite reads the package's
 * own source and asserts the constructs are absent rather than disabled.
 *
 * It is a structural tripwire, deliberately crude. A determined author can
 * evade any token list; the point is that adding a network client has to be
 * a deliberate act that also edits this file, which is exactly the review
 * moment that should exist.
 */

const SOURCE_DIR = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_DIR = join(SOURCE_DIR, "..");

/**
 * Network, filesystem, process-environment, and signing-material
 * constructs. Matched case-sensitively and as plain substrings: this file
 * is excluded from its own scan, which is why the tokens can be written out
 * here in full.
 */
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
  "node:fs",
  "node:child_process",
  "process.env",
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
] as const;

/** The layer graph allows this package exactly these two workspace imports. */
const PERMITTED_WORKSPACE_IMPORTS = ["@vigil/contracts", "@vigil/market"];

const WORKSPACE_IMPORT = /from "(@vigil\/[^"]+)"/g;

function sourceFiles(): readonly string[] {
  return readdirSync(SOURCE_DIR, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .map((entry) => join(SOURCE_DIR, entry));
}

describe("the paper adapter reaches no endpoint and holds no credential", () => {
  it("has source files to check at all", () => {
    // Without this, a scan that silently found nothing would pass every
    // assertion below by vacuity.
    expect(sourceFiles().length).toBeGreaterThan(5);
  });

  it("contains no network, filesystem, environment, or signing construct", () => {
    const findings: string[] = [];
    for (const file of sourceFiles()) {
      const contents = readFileSync(file, "utf8");
      for (const construct of FORBIDDEN_CONSTRUCTS) {
        if (contents.includes(construct)) {
          findings.push(`${file}: ${construct}`);
        }
      }
    }
    expect(findings).toEqual([]);
  });

  it("imports only the two workspace packages the layer graph permits", () => {
    const imported = new Set<string>();
    for (const file of sourceFiles()) {
      const contents = readFileSync(file, "utf8");
      for (const match of contents.matchAll(WORKSPACE_IMPORT)) {
        const specifier = match[1];
        if (specifier !== undefined) {
          imported.add(specifier);
        }
      }
    }
    expect([...imported].filter((specifier) => !PERMITTED_WORKSPACE_IMPORTS.includes(specifier))).toEqual([]);
  });

  it("declares only zod and those two workspace packages as dependencies", () => {
    const manifest = z
      .object({
        name: z.string(),
        dependencies: z.record(z.string(), z.string()),
      })
      .parse(JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")));

    expect(manifest.name).toBe("@vigil/adapter-paper");
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@vigil/contracts", "@vigil/market", "zod"]);
  });
});
