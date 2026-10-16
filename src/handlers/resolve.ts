import { findMatch, listStreams } from "../api/damitv.js";
import { makeEmbedSlot, slotFromEmbedUrl } from "../embed/slot.js";
import { unlockEmbedSlot } from "../embed/unlock.js";
import { relayLink } from "../proxy/media.js";
import type { ResolveResult, StreamLink } from "../types/models.js";

export type ResolveInput = {
  matchId?: string;
  source?: string;
  id?: string;
  stream?: string | number;
};

function pickLink(links: StreamLink[], stream: string | number | undefined): StreamLink {
  const playable = links.filter((link) => link.embedUrl);
  if (!playable.length) throw new Error("no active streams for this slot");
  if (stream != null) {
    const hit = playable.find((link) => String(link.streamNo) === String(stream));
    if (!hit) throw new Error(`stream ${stream} not found`);
    return hit;
  }
  return playable[0]!;
}

async function slotFromInput(input: ResolveInput): Promise<{
  slot: ReturnType<typeof makeEmbedSlot>;
  matchId?: string;
  title?: string;
  embedUrl: string;
  source: string;
  id: string;
}> {
  if (input.matchId) {
    const match = await findMatch(input.matchId);
    const src = input.source ? match.sources.find((entry) => entry.source === input.source) : match.sources[0];
    if (!src) throw new Error(`source ${input.source ?? "(default)"} not on match`);
    const link = pickLink(await listStreams(src.source, src.id), input.stream);
    return {
      slot: slotFromEmbedUrl(link.embedUrl, link.id),
      matchId: match.id,
      title: match.title,
      embedUrl: link.embedUrl,
      source: link.source,
      id: link.id,
    };
  }

  if (!input.source || !input.id) throw new Error("matchId or source+id required");
  const link = pickLink(await listStreams(input.source, input.id), input.stream);
  return {
    slot: slotFromEmbedUrl(link.embedUrl, link.id),
    embedUrl: link.embedUrl,
    source: link.source,
    id: link.id,
  };
}

export async function resolveStream(input: ResolveInput, origin: string): Promise<ResolveResult> {
  let packed: Awaited<ReturnType<typeof slotFromInput>>;
  try {
    packed = await slotFromInput(input);
  } catch (err) {
    return { ok: false, stage: "input", error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const { m3u8, referer } = await unlockEmbedSlot(packed.slot);
    const result = {
      ok: true as const,
      source: packed.source,
      id: packed.id,
      embedUrl: packed.embedUrl,
      m3u8,
      referer,
      relay: relayLink(origin, m3u8, referer, { source: packed.source, id: packed.id }),
    };
    if (packed.matchId) (result as { matchId?: string }).matchId = packed.matchId;
    if (packed.title) (result as { title?: string }).title = packed.title;
    return result;
  } catch (err) {
    return { ok: false, stage: "resolve", error: err instanceof Error ? err.message : String(err) };
  }
}
