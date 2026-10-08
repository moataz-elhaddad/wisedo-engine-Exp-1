// ProductSource: where the product candidates for the FINAL recommendation come from.
//
//   ProductSource
//     ├── ExistingCatalogProductSource   the tenant's catalog snapshot (D1), exactly as before
//     └── LLMProductDiscoverySource      multi-LLM discovery -> consolidation -> verification -> ephemeral snapshot
//
// Both return the same thing: {snapshot, meta}, where snapshot is a CatalogSnapshot (docs/CONTRACTS.md).
// The Recommendation Engine (src/layer2 match()) is called the same way for both, with the same NeedProfile and
// the same `now`, so the two sourcing strategies can be compared on equal terms (recommendWith below).
import { match } from '../layer2/index.js';
import { discoverProducts } from './discover.js';

export class ExistingCatalogProductSource {
  /** @param {any} catalogSnapshot */
  constructor(catalogSnapshot) { this.id = 'catalog'; this.catalogSnapshot = catalogSnapshot; }
  async getSnapshot() {
    return { snapshot: this.catalogSnapshot, meta: { source: 'catalog', snapshot_id: this.catalogSnapshot.snapshot_id } };
  }
}

export class LLMProductDiscoverySource {
  /**
   * @param {{providers: any[], missing?: any[], configs: Record<string, any>, fetch?: typeof fetch,
   *          verify?: any, deadlineMs?: number, requestId?: string, clock?: () => number}} opts
   */
  constructor(opts) { this.id = 'llm_discovery'; this.opts = opts; }
  /** @param {{profile: any, now: any}} input */
  async getSnapshot({ profile, now }) {
    const config = this.opts.configs[profile.category];
    if (!config) throw new Error(`no config for category "${profile.category}"`);
    const d = await discoverProducts({ ...this.opts, profile, config, now });
    const { snapshot, ...meta } = d;
    return { snapshot, meta: { source: 'llm_discovery', ...meta } };
  }
}

/**
 * Run the unchanged Recommendation Engine on whatever a ProductSource returns.
 * @param {ExistingCatalogProductSource|LLMProductDiscoverySource} source
 * @param {any} profile final NeedProfile
 * @param {any} now
 */
export async function recommendWith(source, profile, now) {
  const { snapshot, meta } = await source.getSnapshot({ profile, now });
  const result = match(profile, snapshot, now, 'rank');
  return { source: source.id, snapshot, meta, result };
}
