const sourceCatalog = [
  { id: "ppv", name: "PPV", description: "" },
  { id: "manual", name: "Manual", description: "" },
  { id: "streamed", name: "Streamed", description: "" },
] as const;

const sourceTiers = [{ priority: 1, sources: ["ppv", "manual", "streamed"] }] as const;

export function sourceRank(source: string): number {
  for (const tier of sourceTiers) {
    const index = (tier.sources as readonly string[]).indexOf(source);
    if (index >= 0) return tier.priority * 100 + index;
  }
  return 999;
}

export function sourceMeta(source: string): { name: string; description: string } {
  const hit = sourceCatalog.find((item) => item.id === source);
  return hit
    ? { name: hit.name, description: hit.description }
    : { name: source.charAt(0).toUpperCase() + source.slice(1), description: "" };
}
