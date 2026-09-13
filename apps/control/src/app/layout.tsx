import type { ReactNode } from "react";

import { loadControlConfig } from "@/lib/env";

/**
 * layout.tsx — the mode banner every apps/control surface carries
 * (`apps/control/README.md` "The mode banner"; BOOT-07 acceptance item 1).
 * `force-dynamic` keeps both the banner and every page under it from ever
 * being statically cached: a dashboard that shows yesterday's operating
 * mode is a worse failure than one that renders on every request.
 *
 * Plain server-rendered HTML with one inline stylesheet — no client
 * component, no UI library, no `fetch` (BOOT-07 brief, "Design").
 */
export const dynamic = "force-dynamic";

const STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #f5f5f7; color: #1a1a1a; }
  .mode-bar {
    padding: 18px 24px;
    font-size: 1.4rem;
    font-weight: 700;
    text-align: center;
    letter-spacing: 0.02em;
  }
  .mode-bar.paper { background: #0a6b3a; color: #fff; }
  .mode-bar.paused { background: #b45309; color: #fff; }
  .mode-bar.blocked { background: #7c2d12; color: #fff; }
  .mode-bar.config-error { background: #7f1d1d; color: #fff; }
  .page-body { padding: 24px; max-width: 1100px; margin: 0 auto; }
  .blocking-page { padding: 48px 24px; text-align: center; max-width: 720px; margin: 0 auto; }
  section { margin-bottom: 40px; }
  h2 { border-bottom: 2px solid #d0d0d5; padding-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border: 1px solid #d8d8de; padding: 8px 12px; text-align: left; font-size: 0.9rem; }
  th { background: #eaeaef; }
  .empty { color: #666; font-style: italic; }
`;

function bannerBody(mode: string): { readonly className: string; readonly text: string } {
  if (mode === "PAUSED") {
    return { className: "paused", text: "PAUSED MODE — new risk blocked, protective actions still run" };
  }
  return { className: "paper", text: "PAPER MODE — simulated execution, no real funds" };
}

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  const result = loadControlConfig();

  if (result.outcome === "error") {
    return (
      <html lang="en">
        <head>
          <title>vigil control — configuration error</title>
          <style>{STYLES}</style>
        </head>
        <body>
          <div className="mode-bar config-error">CONFIGURATION ERROR — dashboard cannot start</div>
          <main className="blocking-page">
            <h1>Configuration error</h1>
            <p>{result.detail}</p>
            <p>
              Set a valid <code>VIGIL_MODE</code> and <code>DATABASE_URL</code> (see{" "}
              <code>.env.example</code>) and restart.
            </p>
          </main>
        </body>
      </html>
    );
  }

  const { mode } = result.config;

  if (mode === "SHADOW" || mode === "LIVE") {
    return (
      <html lang="en">
        <head>
          <title>vigil control — {mode} not reachable</title>
          <style>{STYLES}</style>
        </head>
        <body>
          <div className="mode-bar blocked">
            {mode} NOT REACHABLE — this build cannot enter {mode}
          </div>
          <main className="blocking-page">
            <p>
              This build only ever runs in PAPER or PAUSED. No holdings, reservations, candidates,
              costs, audit trail, or runtime health are shown while <code>VIGIL_MODE</code> is{" "}
              {mode}.
            </p>
          </main>
        </body>
      </html>
    );
  }

  const banner = bannerBody(mode);

  return (
    <html lang="en">
      <head>
        <title>vigil control — {mode}</title>
        <style>{STYLES}</style>
      </head>
      <body>
        <div className={`mode-bar ${banner.className}`}>{banner.text}</div>
        <div className="page-body">{children}</div>
      </body>
    </html>
  );
}
