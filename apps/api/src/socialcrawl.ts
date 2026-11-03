/**
 * Social ingest behind a provider seam — a post link in, the post's media and
 * what the platform says about it out.
 *
 * Shaped after fal.ts and tts.ts for the same reason: the interesting part is
 * the contract, not the vendor. SocialCrawl (socialcrawl.dev) is one key over
 * many platforms with a unified response envelope, which is what makes it a
 * seam rather than a scraper we maintain.
 *
 * This reverses a decision, knowingly: plans/003 chose "users bring their own
 * media" on 2026-08-19 and built no fetcher. The user chose to integrate one on
 * 2026-09-17; plans/003 records the change and what it leaves open.
 *
 * **Media links are short-lived.** SocialCrawl can host durable copies, but not
 * for login-gated posts (age-restricted ones, for example): those come back
 * with signed CDN links only, which expire. So the caller must fetch the bytes
 * inside the same request rather than store a link — `fetchMedia` exists to
 * make that the obvious thing to do.
 *
 * Web-standard APIs only (fetch, URL), no Cloudflare types, so the adapter
 * stays portable and testable outside the worker.
 */

const BASE = 'https://www.socialcrawl.dev'

export type SocialCrawlErrorCode =
  | 'no_api_key'
  | 'unsupported_url'
  | 'provider_error'
  | 'not_found'
  | 'no_media'

export class SocialCrawlError extends Error {
  constructor(
    readonly code: SocialCrawlErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SocialCrawlError'
  }
}

export interface SocialPost {
  platform: string
  /** The canonical post URL the provider resolved to. */
  url: string
  /** Stable per-platform id, used to name the imported file. */
  id: string
  mediaType: string
  /** Every media link on the post, in order. Short-lived — fetch now. */
  mediaUrls: string[]
  thumbnailUrl: string | null
  durationSec: number | null
  caption: string
  author: { username: string | null; verified: boolean }
  views: number | null
  /** Provider warnings, passed through verbatim — they explain degraded reads. */
  warnings: string[]
}

/**
 * Which links this adapter reads. One platform today, deliberately: every
 * platform has its own endpoint and its own quirks, and a platform is added
 * when it has been exercised against a real post, not when the vendor lists it.
 */
const PLATFORMS: { platform: string; hosts: RegExp; endpoint: string }[] = [
  {
    platform: 'instagram',
    hosts: /(^|\.)instagram\.com$/i,
    endpoint: '/v1/instagram/post',
  },
]

export function supportedPlatforms(): string[] {
  return PLATFORMS.map((p) => p.platform)
}

function platformFor(link: string) {
  let host: string
  try {
    host = new URL(link).hostname
  } catch {
    throw new SocialCrawlError('unsupported_url', `"${link}" is not a URL`)
  }
  const hit = PLATFORMS.find((p) => p.hosts.test(host))
  if (!hit) {
    throw new SocialCrawlError(
      'unsupported_url',
      `${host} is not a platform this can import from. Supported: ${supportedPlatforms().join(', ')}. ` +
        `For anything else, upload the file`,
    )
  }
  return hit
}

interface Envelope {
  success?: boolean
  data?: {
    post?: {
      id?: string | number
      url?: string
      content?: {
        text?: string | null
        media_urls?: string | string[] | null
        thumbnail_url?: string | null
        duration_seconds?: number | null
      }
      author?: { username?: string | null; verified?: boolean | null }
      engagement?: { views?: number | null }
      ext?: { media_type?: string | null }
    }
    _warnings?: string[]
  }
  error?: { type?: string; message?: string; doc_url?: string }
}

export interface SocialCrawlProvider {
  readonly name: string
  getPost(link: string): Promise<SocialPost>
  /** Fetch one media link's bytes, for handing straight to storeAsset. */
  fetchMedia(url: string): Promise<{ body: ArrayBuffer; mime: string }>
}

export function socialCrawlProvider(apiKey: string): SocialCrawlProvider {
  if (!apiKey) throw new SocialCrawlError('no_api_key', 'SOCIALCRAWL_API_KEY is not configured')

  return {
    name: 'socialcrawl',

    async getPost(link) {
      const { platform, endpoint } = platformFor(link)
      const query = new URL(`${BASE}${endpoint}`)
      query.searchParams.set('url', link)
      // Asks for durable copies. They are not always possible (login-gated
      // posts), and the warning that comes back says so — it is passed through.
      query.searchParams.set('download_media', 'true')

      const res = await fetch(query, { headers: { 'x-api-key': apiKey } })
      const body = (await res.json().catch(() => ({}))) as Envelope
      if (!res.ok || !body.success) {
        const detail = body.error?.message ?? body.error?.type ?? `HTTP ${res.status}`
        const code = res.status === 404 ? 'not_found' : 'provider_error'
        throw new SocialCrawlError(code, `socialcrawl could not read ${link}: ${detail}`)
      }

      const post = body.data?.post
      if (!post) throw new SocialCrawlError('not_found', `socialcrawl returned no post for ${link}`)
      const raw = post.content?.media_urls
      const mediaUrls = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(Boolean)

      return {
        platform,
        url: post.url ?? link,
        id: String(post.id ?? ''),
        mediaType: post.ext?.media_type ?? 'unknown',
        mediaUrls,
        thumbnailUrl: post.content?.thumbnail_url ?? null,
        durationSec: post.content?.duration_seconds ?? null,
        caption: post.content?.text ?? '',
        author: {
          username: post.author?.username ?? null,
          verified: !!post.author?.verified,
        },
        views: post.engagement?.views ?? null,
        warnings: body.data?._warnings ?? [],
      }
    },

    async fetchMedia(url) {
      const res = await fetch(url)
      if (!res.ok) {
        throw new SocialCrawlError(
          'no_media',
          `the media link answered ${res.status} — these links are short-lived, so import again to get a fresh one`,
        )
      }
      return {
        body: await res.arrayBuffer(),
        mime: (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim(),
      }
    },
  }
}
