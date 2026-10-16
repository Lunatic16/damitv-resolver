import { unlockEmbed } from "./decrypt.js";
import type { EmbedSlot } from "./slot.js";

export async function unlockEmbedSlot(embed: EmbedSlot): Promise<{ m3u8: string; referer: string }> {
  // Serve the master playlist as-is: players (hls.js, mpv, VLC) pick the best
  // variant AND the audio rendition group themselves. Collapsing to the
  // highest-bandwidth media playlist silently drops audio on CDNs that deliver
  // renditions separately (e.g. Akamai EXT-X-MEDIA audio groups).
  const m3u8 = await unlockEmbed(embed);
  return { m3u8, referer: `${embed.origin}/` };
}
