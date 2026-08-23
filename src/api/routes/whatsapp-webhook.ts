import { Elysia, t } from '@/api/http';
import { apiLogger } from '@/utils/logger';

/**
 * WhatsApp webhook endpoint — unauthenticated (called by Meta).
 *
 * GET  /api/channels/whatsapp/webhook — verification (hub.challenge)
 * POST /api/channels/whatsapp/webhook — incoming messages
 */
export const whatsappWebhookRoutes = new Elysia({ prefix: '/channels/whatsapp' })
  // Webhook verification (Meta sends GET with hub.* params)
  .get(
    '/webhook',
    async ({ query }) => {
      const { getUMI } = await import('@/channels');
      const umi = getUMI();
      const channel = umi.getChannel('whatsapp');

      if (!channel) {
        apiLogger.warn('WhatsApp webhook verification attempted but channel not registered');
        // 404, not 503. An unregistered channel is a permanent condition on
        // this install, not a service that is temporarily down: 503 invites
        // Meta to retry a verification that can never succeed, and it makes a
        // deployment that simply doesn't use WhatsApp look like a failing
        // server to any 5xx-based alerting. The POST branch below already
        // treats the same state as non-fatal.
        return new Response('Channel not configured', { status: 404 });
      }

      const whatsapp = channel as import('@/channels/whatsapp').WhatsAppChannel;
      const result = whatsapp.handleVerification(query as Record<string, string>);

      return new Response(result.body, { status: result.status });
    },
    {
      query: t.Object({
        'hub.mode': t.Optional(t.String()),
        'hub.verify_token': t.Optional(t.String()),
        'hub.challenge': t.Optional(t.String()),
      }),
      detail: { tags: ['channels'] },
    },
  )
  // Incoming messages from Meta
  .post(
    '/webhook',
    async ({ body, request }) => {
      const { getUMI } = await import('@/channels');
      const umi = getUMI();
      const channel = umi.getChannel('whatsapp');

      if (!channel) {
        apiLogger.warn('WhatsApp webhook received but channel not registered');
        return new Response('OK', { status: 200 }); // Always 200 to Meta
      }

      const whatsapp = channel as import('@/channels/whatsapp').WhatsAppChannel;

      // Signature is over the exact bytes Meta sent, so read them from the
      // request rather than re-serialising the parsed body. The body parser
      // works on a clone, so this is still the untouched payload.
      //
      // This used to depend on a raw string an `onParse` hook stashed on the
      // request object, and skipped verification entirely when that string was
      // absent — a guard the shipping path could miss. It cannot be missing now.
      const rawBody = await request.text();
      const signatureHeader = request.headers.get('x-hub-signature-256');
      if (signatureHeader && !whatsapp.verifySignature(rawBody, signatureHeader)) {
        apiLogger.warn({ ip: request.headers.get('x-forwarded-for') }, 'WhatsApp webhook signature mismatch — rejecting');
        return new Response('Forbidden', { status: 403 });
      }

      // Process asynchronously — always return 200 quickly to Meta
      whatsapp.processWebhook(body as any).catch((error) => {
        apiLogger.error({ error }, 'Failed to process WhatsApp webhook');
      });

      return new Response('OK', { status: 200 });
    },
    {
      detail: { tags: ['channels'] },
    },
  );
