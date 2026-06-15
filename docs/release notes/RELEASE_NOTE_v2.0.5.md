# Release Note - v2.0.5

Version `v2.0.5` adds periodic node capability health checks and automatic
template support reduction when local runtime dependencies become unavailable.

## Node capability health checks

Oracle nodes now run periodic local checks for:

- LLM task execution configuration;
- IPFS/Filebase storage publication configuration.

The checks are started by the node daemon after boot and run periodically while
the node is active.

Default configuration:

```env
TEMPLATE_HEALTH_WORKER_ENABLED=true
TEMPLATE_HEALTH_INITIAL_DELAY_MS=30000
TEMPLATE_HEALTH_INTERVAL_MS=300000

LLM_HEALTH_CHECK_ENABLED=true
LLM_HEALTH_TIMEOUT_MS=20000

IPFS_HEALTH_CHECK_ENABLED=true
```

## Automatic template support removal

If the LLM health check fails, the node updates its on-chain
`accepted_template_ids` and removes templates whose task type contains `LLM`.

If the IPFS health check fails, the node updates its on-chain
`accepted_template_ids` and removes templates that require storage/IPFS support:

- task types containing `IPFS`;
- task types containing `STORAGE`;
- templates with `allow_storage = true`.

The update is performed by re-registering the oracle node with the filtered
template list. This prevents a node with broken local dependencies from being
assigned tasks it cannot execute.

## IPFS check behavior

The IPFS check performs a small test upload and then attempts best-effort
cleanup of the uploaded CID.

This catches runtime failures such as:

- unreachable IPFS/Filebase endpoint;
- invalid or revoked credentials;
- backend network resolution failures;
- disabled local IPFS configuration.

## LLM check behavior

The LLM check performs a minimal deterministic JSON request against the
configured LLM provider.

This catches runtime failures such as:

- missing or invalid LLM API configuration;
- revoked credentials;
- unavailable model or gateway;
- provider/network timeout.

## Operational impact

The node no longer needs to be restarted to react to dependency failures that
happen after boot. Once a health check fails, the node reduces its advertised
capabilities on-chain during the next health-check cycle.
