import { Hono } from 'hono'
import Stripe from 'stripe'
import type { Env, Vars } from './env'

/** Credit packs. Amounts are USD cents; 1 credit ≈ $0.01 with volume discount above. */
export const PACKS = {
  starter: { credits: 500, cents: 500 },
  creator: { credits: 2200, cents: 2000 },
  studio: { credits: 6000, cents: 5000 },
} as const
export type PackId = keyof typeof PACKS

function stripeClient(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  })
}

export async function getBalance(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT balance FROM credits WHERE user_id = ?')
    .bind(userId)
    .first<{ balance: number }>()
  return row?.balance ?? 0
}

export async function adjustCredits(
  env: Env,
  userId: string,
  delta: number,
  reason: string,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO credits (user_id, balance) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance`,
    ).bind(userId, delta),
    env.DB.prepare(
      'INSERT INTO credit_ledger (id, user_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), userId, delta, reason, Date.now()),
  ])
}

// Authenticated billing routes (mounted under /api/billing)
export const billing = new Hono<{ Bindings: Env; Variables: Vars }>()

billing.get('/balance', async (c) => {
  return c.json({ balance: await getBalance(c.env, c.get('userId')), packs: PACKS })
})

billing.post('/checkout', async (c) => {
  const { pack } = (await c.req.json()) as { pack: PackId }
  const def = PACKS[pack]
  if (!def) return c.json({ error: 'unknown_pack' }, 400)
  const session = await stripeClient(c.env).checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: def.cents,
          product_data: { name: `Euclid — ${def.credits} credits` },
        },
      },
    ],
    success_url: `${c.env.APP_ORIGIN}/credits?status=success`,
    cancel_url: `${c.env.APP_ORIGIN}/credits?status=cancelled`,
    metadata: { userId: c.get('userId'), credits: String(def.credits) },
  })
  return c.json({ url: session.url })
})

/** Unauthenticated — Stripe calls this. Mounted at /api/billing/webhook in index.ts. */
export async function handleStripeWebhook(env: Env, request: Request): Promise<Response> {
  const sig = request.headers.get('stripe-signature')
  if (!sig) return new Response('missing signature', { status: 400 })
  const body = await request.text()
  let event: Stripe.Event
  try {
    event = await stripeClient(env).webhooks.constructEventAsync(
      body,
      sig,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    )
  } catch {
    return new Response('bad signature', { status: 400 })
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const userId = session.metadata?.userId
    const credits = Number(session.metadata?.credits ?? 0)
    if (userId && credits > 0) {
      await adjustCredits(env, userId, credits, `stripe:${session.id}`)
    }
  }
  return new Response('ok')
}
