import { assetIdsInDoc, type EuclidDoc } from '@euclid/dsl'
import type { Page } from 'playwright'

/**
 * Push the media a document draws — stills and clips — into the page, as
 * data URLs.
 *
 * The render surface has no session and no internal key, so it cannot fetch a
 * project asset itself. Both capture paths therefore have to do this — the
 * export worker and the preview/contact-sheet server — and they must do it the
 * same way, or `preview_frames` shows an agent something the export will not
 * contain. That is the one thing the preview path must never do, so this lives
 * in one function rather than in two loops that drift.
 *
 * Audio is deliberately excluded: ffmpeg muxes it from files on disk and it
 * never reaches the page, so preloading it would move megabytes for nothing.
 */
export function imageAssetIds(doc: EuclidDoc): string[] {
  const drawn = new Set<string>()
  const walk = (nodes: EuclidDoc['scenes'][number]['nodes']): void => {
    for (const n of nodes) {
      // Both kinds the *stage* draws. Video is fetched whole rather than
      // streamed: the page seeks around inside it, and a data URL it already
      // holds is the only version of that which needs no session.
      if (n.type === 'image' || n.type === 'video') drawn.add(n.assetId)
      else if (n.type === 'group') walk(n.children)
    }
  }
  for (const scene of doc.scenes) walk(scene.nodes)
  // Intersected with the document's own reference set, which is what the
  // delete guard uses — an id drawn but not "referenced" would be a bug in one
  // of the two, and this is where they meet.
  const known = assetIdsInDoc(doc)
  return [...drawn].filter((id) => known.has(id))
}

export async function preloadImages(
  page: Page,
  doc: EuclidDoc,
  opts: { apiUrl: string; headers: Record<string, string>; log?: (m: string) => void },
): Promise<number> {
  const ids = imageAssetIds(doc)
  for (const assetId of ids) {
    const res = await fetch(`${opts.apiUrl}/api/assets/${assetId}`, { headers: opts.headers })
    if (!res.ok) throw new Error(`asset ${assetId} fetch failed: ${res.status}`)
    const mime = res.headers.get('content-type') ?? 'application/octet-stream'
    const b64 = Buffer.from(await res.arrayBuffer()).toString('base64')
    await page.evaluate(
      ([id, url]) => window.__euclid.preloadAsset(id as string, url as string),
      [assetId, `data:${mime};base64,${b64}`] as [string, string],
    )
    opts.log?.(`  preloaded ${assetId} (${mime})`)
  }
  return ids.length
}
