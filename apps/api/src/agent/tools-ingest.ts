import { LIMITS, uploadKindFor } from '@euclid/dsl'
import { z } from 'zod'
import { storeAsset } from '../services/assets'
import { SocialCrawlError, socialCrawlProvider, supportedPlatforms } from '../socialcrawl'
import { PROJECT_ID } from './schemas'
import { capability, said, CapabilityError } from './types'

/**
 * Ingest from a link (plans/003 §5, reversed 2026-09-17).
 *
 * Upload stays the front door for the user's own files; this is the second
 * door, for a post that lives on a platform. Everything downstream is shared:
 * the file lands as an ordinary video asset, so probe, shot detection and the
 * proxy pick it up exactly as they would an upload.
 */
export const ingestTools = [
  capability({
    name: 'import_social_video',
    summary: 'Import a video post (e.g. an Instagram reel) from its link into the project.',
    doc: [
      'Free. Reads the post through SocialCrawl, downloads its video **in the same call**, and files it as a project video asset.',
      '',
      `Supported: ${supportedPlatforms().join(', ')}. Anything else is refused with that list — upload the file instead.`,
      '',
      '**Download now, not later.** Platform media links are signed and short-lived, and for login-gated posts (age-restricted ones, for example) no durable copy can be made at all. That is why this capability returns a stored asset rather than a link: a link would work in this reply and fail in the next.',
      '',
      '**Then `get_shots`.** Probe and shot detection run in the background after the file lands, exactly as for an upload, so the cuts are not known immediately — ask again shortly, and read "not watched yet" as pending rather than as one continuous take.',
      '',
      'The response carries the post\'s author, caption and duration, so a plan can say what it is cloning.',
    ].join('\n'),
    args: z.object({
      projectId: PROJECT_ID,
      url: z.string().url().describe('the post link, e.g. https://www.instagram.com/reel/…'),
      path: z.string().optional().describe('where to file it; defaults to /source/<author>-<post id>.mp4'),
    }),
    result: z.object({
      assetId: z.string(),
      path: z.string(),
      bytes: z.number(),
      durationSec: z.number().nullable(),
      platform: z.string(),
      author: z.string().nullable(),
      caption: z.string(),
    }),
    async handler(ctx, { projectId, url, path }) {
      await ctx.requireProject(projectId)
      if (!ctx.env.SOCIALCRAWL_API_KEY) {
        throw new CapabilityError(
          'importing from a link is not configured on this deployment — SOCIALCRAWL_API_KEY is unset. Upload the file instead',
          501,
        )
      }
      const provider = socialCrawlProvider(ctx.env.SOCIALCRAWL_API_KEY)

      try {
        const post = await provider.getPost(url)
        if (post.mediaType !== 'video' || post.mediaUrls.length === 0) {
          throw new CapabilityError(
            `${post.url} is a ${post.mediaType} post with ${post.mediaUrls.length} media link(s), not a video — ` +
              `this imports video posts`,
            422,
          )
        }

        const media = await provider.fetchMedia(post.mediaUrls[0]!)
        const kind = uploadKindFor(media.mime)
        if (kind !== 'video') {
          throw new CapabilityError(
            `the post's media arrived as ${media.mime}, which is not a video type this system stores`,
            422,
          )
        }
        if (media.body.byteLength > LIMITS.maxUploadBytes) {
          throw new CapabilityError(
            `the video is ${Math.round(media.body.byteLength / 1e6)}MB, over the ${LIMITS.maxUploadBytes / 1e6}MB file ceiling`,
            413,
          )
        }

        const who = (post.author.username ?? post.platform).replace(/[^a-z0-9_.-]/gi, '')
        const stored = await storeAsset(ctx.env, projectId, {
          kind: 'video',
          mime: media.mime,
          durationSec: post.durationSec,
          path: path ?? `/source/${who}-${post.id || 'post'}.mp4`,
          body: media.body,
        })

        const lines = [
          `imported ${post.platform} video by @${post.author.username ?? 'unknown'}` +
            `${post.author.verified ? ' (verified)' : ''}: ${stored.path}, ` +
            `${Math.round(stored.bytes / 1024)}KB` +
            (post.durationSec ? `, ${post.durationSec.toFixed(2)}s` : '') +
            ` (asset ${stored.assetId})`,
          post.caption ? `caption: ${post.caption.slice(0, 200)}` : '',
          `Shot detection runs in the background — call get_shots on ${stored.assetId} shortly.`,
        ].filter(Boolean)
        return said(lines.join('\n'), {
          assetId: stored.assetId,
          path: stored.path,
          bytes: stored.bytes,
          durationSec: post.durationSec,
          platform: post.platform,
          author: post.author.username,
          caption: post.caption,
        })
      } catch (e) {
        if (e instanceof SocialCrawlError) {
          const status = e.code === 'unsupported_url' ? 400 : e.code === 'not_found' ? 404 : 502
          throw new CapabilityError(e.message, status)
        }
        throw e
      }
    },
  }),
]
