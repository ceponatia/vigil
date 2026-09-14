import { loadControlConfig } from "@/lib/env";
import { loadDashboardData } from "@/lib/data";

/**
 * page.tsx — the dashboard overview (BOOT-07 brief, "Design"): Holdings,
 * Reservations, Candidates, Costs, Audit trail, Runtime health. Every
 * value here is a plain string or number already formatted by
 * `src/lib/data.ts` — this component only lays them out.
 */
export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const config = loadControlConfig();
  if (config.outcome !== "ok" || config.config.mode === "SHADOW" || config.config.mode === "LIVE") {
    // The layout already renders a full-page block for both of these
    // states; this only guards against this page ever querying a database
    // for a mode this build cannot trade in.
    return null;
  }

  const result = await loadDashboardData(config.config);
  if (result.outcome === "error") {
    // `result.detail` is always a fixed, safe sentence (never a raw driver
    // message — `src/lib/data.ts` logs that server-side only, since it can
    // carry the connection string's host, port, or role).
    return (
      <main>
        <h1>Runtime data unavailable</h1>
        <p>Error code: {result.code}</p>
        <p>{result.detail}</p>
      </main>
    );
  }

  const { data } = result;

  return (
    <main>
      <h1>Overview</h1>

      {data.runtimeHealth.paused ? (
        <div className="mode-bar paused">PAUSED — a runtime instance reports PAUSED; new risk is blocked</div>
      ) : null}

      <section aria-labelledby="holdings-heading">
        <h2 id="holdings-heading">Holdings</h2>
        {data.holdings.length === 0 ? (
          <p className="empty">no holdings recorded</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>State</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.holdings.flatMap((asset) =>
                asset.states.map((item) => (
                  <tr key={`${asset.assetId}-${item.state}`}>
                    <td>{asset.assetId}</td>
                    <td>{item.state}</td>
                    <td>{item.amount}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="reservations-heading">
        <h2 id="reservations-heading">Reservations</h2>
        {data.reservations.length === 0 ? (
          <p className="empty">no active reservations</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Reservation</th>
                <th>Intent</th>
                <th>Attempt</th>
                <th>Asset</th>
                <th>Amount</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {data.reservations.map((reservation) => (
                <tr key={reservation.reservationId}>
                  <td>{reservation.reservationId}</td>
                  <td>{reservation.intentId}</td>
                  <td>{reservation.attempt}</td>
                  <td>{reservation.assetId}</td>
                  <td>{reservation.amount}</td>
                  <td>{reservation.expiresAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="candidates-heading">
        <h2 id="candidates-heading">Candidates</h2>
        {data.candidates.length === 0 ? (
          <p className="empty">no candidates recorded</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Instrument</th>
                <th>Zone</th>
                <th>Expires</th>
                <th>Validity</th>
                <th>Reason</th>
                <th>Last evaluated</th>
              </tr>
            </thead>
            <tbody>
              {data.candidates.map((candidate) => (
                <tr key={candidate.candidateId}>
                  <td>{candidate.candidateId}</td>
                  <td>{candidate.instrumentId}</td>
                  <td>{candidate.entryZone}</td>
                  <td>{candidate.expiresAt}</td>
                  <td>{candidate.validityState}</td>
                  <td>{candidate.reasonCode ?? "—"}</td>
                  <td>{candidate.latestEvaluationAt ?? "never evaluated"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="costs-heading">
        <h2 id="costs-heading">Costs</h2>
        {data.costs.length === 0 ? (
          <p className="empty">no costs recorded</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Total fees</th>
              </tr>
            </thead>
            <tbody>
              {data.costs.map((cost) => (
                <tr key={cost.assetId}>
                  <td>{cost.assetId}</td>
                  <td>{cost.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="audit-heading">
        <h2 id="audit-heading">Audit trail</h2>
        {data.auditTrail.length === 0 ? (
          <p className="empty">no journal entries recorded</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Occurred</th>
                <th>Correlation</th>
                <th>Intent</th>
                <th>Policy</th>
                <th>Strategy</th>
                <th>Model</th>
              </tr>
            </thead>
            <tbody>
              {data.auditTrail.map((entry) => (
                <tr key={entry.entryId}>
                  <td>{entry.kind}</td>
                  <td>{entry.occurredAt}</td>
                  <td>{entry.correlationId}</td>
                  <td>{entry.intentId ?? "—"}</td>
                  <td>{entry.policyVersion}</td>
                  <td>{entry.strategyVersion}</td>
                  <td>{entry.modelVersion ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="health-heading">
        <h2 id="health-heading">Runtime health</h2>
        {data.runtimeHealth.instances.length === 0 ? (
          <p className="empty">NO HEARTBEAT EVER RECEIVED</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Process</th>
                <th>Instance</th>
                <th>Mode</th>
                <th>Heartbeat</th>
                <th>Quote</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.runtimeHealth.instances.map((instance) => (
                <tr key={`${instance.process}-${instance.instanceId}`}>
                  <td>{instance.process}</td>
                  <td>{instance.instanceId}</td>
                  <td>{instance.mode}</td>
                  <td>
                    {instance.heartbeatStatus}
                    {instance.heartbeatAgeMs !== null ? ` (${instance.heartbeatAgeMs}ms)` : ""}
                  </td>
                  <td>
                    {instance.quoteStatus}
                    {instance.quoteAgeMs !== null ? ` (${instance.quoteAgeMs}ms)` : ""}
                  </td>
                  <td>{instance.detail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
