/**
 * One answer to "does this turn advertise every tool schema, or a core set plus
 * `list_tools`/`describe_tool`?"
 *
 * It used to be two answers. The root (`root-runner`) and every worker
 * (`worker-spawner`) each carried their own copy of the same condition, and a
 * copy of a gating rule is a copy that goes stale exactly when someone changes
 * the rule in one place.
 *
 * Both copies read `provider === 'ollama'`, on the reasoning that a local model
 * re-prefills the schema on the iGPU every request while a remote one
 * prefix-caches the block cheaply and tool-calls more reliably with it. The
 * first half is true. The second half was an assumption, and a benchmark put a
 * number on what it costs: the root's standing prompt measured 21,945 tokens,
 * of which 15,935 — 73% — was tool JSON schema, billed in full on every fresh
 * session because a cache prefix only helps within one. Prose is the other
 * quarter, so no amount of rewriting the persona touches this.
 *
 * The condition is now the model's capability rather than its postcode, with a
 * setting to put it back if a provider really does tool-call worse without the
 * full block — which is a claim that can now be measured instead of assumed.
 */

export interface LazyDiscoveryInputs {
  /** Does the role define a core set? Without one there is nothing to split. */
  hasCoreToolIds: boolean;
  /** The SMALL tier chains multi-step discovery badly; it keeps the capped full set. */
  isSmallModel: boolean;
  /** A model that cannot call tools cannot call the discovery meta-tools either. */
  supportsTools: boolean;
  /** `agent.lazyToolDiscovery` — the operator's override. */
  enabled: boolean;
}

/**
 * Whether this turn should advertise a core set plus the discovery meta-tools.
 *
 * Note what is NOT here: the provider. A local model and a remote one both pay
 * for schema they do not use — one in prefill, the other on the bill — and the
 * things that genuinely disqualify a caller (no core set to split, a model too
 * small to chain the round trip, a model that cannot call tools at all) are
 * properties of the role and the model, not of who hosts it.
 */
export function shouldUseLazyDiscovery(inputs: LazyDiscoveryInputs): boolean {
  return (
    inputs.enabled && inputs.hasCoreToolIds && inputs.supportsTools && !inputs.isSmallModel
  );
}
