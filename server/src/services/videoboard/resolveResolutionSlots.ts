/**
 * Given a workflow JSON, find which proxyWidget indices in the first wrapper
 * node correspond to the latent image node's width (slot 0) and height (slot 1).
 *
 * Works by:
 *  1. Finding the wrapper node (has properties.proxyWidgets).
 *  2. Finding the subgraph definition whose id matches the wrapper type.
 *  3. Finding the latent image node inside the subgraph.
 *  4. Following links to find which inner nodes feed slots 0 (width) and 1 (height).
 *  5. Mapping those inner node IDs back to proxy indices.
 *
 * Returns { widthIdx, heightIdx } or null if slots can't be resolved.
 */

const LATENT_NODE_TYPES = new Set([
  'EmptyLatentImage',
  'EmptySD3LatentImage',
  'EmptyFlux2LatentImage',
  'EmptyHunyuanLatentVideo',
]);

export function resolveResolutionProxyIndices(
  workflow: Record<string, unknown>,
): { widthIdx: number; heightIdx: number } | null {
  const topNodes = (workflow.nodes as Array<Record<string, unknown>>) ?? [];
  const wrapperNode = topNodes.find(
    (n) => Array.isArray((n.properties as Record<string, unknown> | undefined)?.proxyWidgets),
  );
  if (!wrapperNode) return null;

  const proxyWidgets = (
    (wrapperNode.properties as Record<string, unknown>).proxyWidgets
  ) as Array<[string | number, string]>;

  const wrapperType = wrapperNode.type as string;
  const subgraphs = (
    (workflow.definitions as Record<string, unknown> | undefined)?.subgraphs ?? []
  ) as Array<Record<string, unknown>>;
  const subgraph = subgraphs.find((s) => s.id === wrapperType) ?? subgraphs[0];
  if (!subgraph) return null;

  const sgNodes = (subgraph.nodes as Array<Record<string, unknown>>) ?? [];
  const latentNode = sgNodes.find((n) => LATENT_NODE_TYPES.has(n.type as string));
  if (!latentNode) return null;

  const latentId = latentNode.id as number | string;
  const links = (subgraph.links as Array<Record<string, unknown>>) ?? [];

  let widthSourceId: string | null = null;
  let heightSourceId: string | null = null;
  for (const lnk of links) {
    if (String(lnk.target_id) === String(latentId)) {
      if (lnk.target_slot === 0) widthSourceId = String(lnk.origin_id);
      if (lnk.target_slot === 1) heightSourceId = String(lnk.origin_id);
    }
  }
  if (!widthSourceId || !heightSourceId) return null;

  let widthIdx = -1;
  let heightIdx = -1;
  for (let i = 0; i < proxyWidgets.length; i++) {
    const [innerNodeId] = proxyWidgets[i];
    if (String(innerNodeId) === widthSourceId && widthIdx < 0) widthIdx = i;
    if (String(innerNodeId) === heightSourceId && heightIdx < 0) heightIdx = i;
  }
  if (widthIdx < 0 || heightIdx < 0) return null;
  return { widthIdx, heightIdx };
}
