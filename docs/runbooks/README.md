[← Documentation index](../README.md)

# Runbooks

A runbook exists only for a mechanism that already exists in the code. None of the mechanisms below are built yet, so none of the runbooks are written — this page is the index of what is planned, not a set of stub procedures to fill in later. A runbook is added in the same change that ships the mechanism it documents, never before.

## Planned

| Runbook                                  | Trigger                                                            | Status      |
| ------------------------------------------- | ----------------------------------------------------------------------- | ------------- |
| Pause new entries                           | Operator or automated risk signal needs to stop new risk immediately without touching open positions | not written |
| Cancel non-protective actions                | Open non-protective orders/transactions need to be pulled while protection stays live | not written |
| Reduce liquid exposure                      | Operator needs to shrink liquid position size without a full exit         | not written |
| Cancel everything where supported            | Operator needs the broadest available stop on a venue that supports it   | not written |
| Credential rotation                          | A venue, RPC, or signer credential must be rotated — controlled pause plus reconciliation before and after | not written |
| Backup restore drill                         | Scheduled verification that an encrypted backup actually restores        | not written |
| Deployment and authority handover             | A new process instance must take over financial authority from the running one without a gap or an overlap | not written |
| Incident response                            | A security event, an unresolved transaction, or an unreconciled balance needs a documented response | not written |
| Gas-reserve replenishment                    | On-chain gas reserve falls below the threshold that protective actions require | not written |
| Operating-budget exhaustion                  | LLM, RPC, data, or hosting spend approaches or hits its ceiling            | not written |
