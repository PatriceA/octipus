/** Public surface of the hwfit hardware-aware model recommender. */
export { CATALOG_VERSION, getCatalogEntry, MODEL_CATALOG } from './catalog';
export { computeBudgetMB, scoreCatalog } from './scorer';
export { clearSizeCache, parseManifestSizeMB, parseModelId, resolveSizes } from './sizing';
export {
  KNOWN_QUANTS,
  KNOWN_TOPICS,
  type CatalogTopic,
  type HardwareProfile,
  type ModelCatalogEntry,
  type QuantLabel,
  type ScoredModel,
  type SizedModel,
} from './types';
