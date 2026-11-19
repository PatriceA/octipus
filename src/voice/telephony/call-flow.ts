/**
 * What a phone call does when its provider reports something — one flow for
 * every provider. The provider reads its webhook into a `TelephonyWebhookEvent`
 * and carries out the `CallInstruction` this returns; nothing here knows a
 * provider's field names or whether it is driven by XML or by API commands.
 *
 *   incoming  → inbound policy → answer → greet → listen (or the media stream)
 *   answered  → say the pending message → listen (conversation) or hang up (notify)
 *   speech    → the phone reply (`reply.ts`) → say it → listen, or hang up on a farewell
 *   spoken    → a line that asked for it has ended: hang up
 *   hangup    → the call is over
 */
import { logger } from '@/utils/logger';
import type { CallInstruction, CallManager, CallSession, SpokenLine, TelephonyProvider, TelephonyWebhookEvent, WebhookReply } from './interface';
import { phonePhrase, telephonyLocale } from './phrases';
import type { PhoneReply } from './reply';

const log = logger.child({ component: 'call-flow' });

export interface CallFlowContext {
  provider: TelephonyProvider;
  callManager: CallManager;
  /** The public URL this webhook was called on: where an XML provider posts what the caller says. */
  callbackUrl: string;
  /** The public origin (`voice.publicUrl`), or '' when none is set. */
  publicBase: string;
  settings: { get(key: string): Promise<unknown> };
  /** Answer what the caller said (reply.ts). */
  reply(call: CallSession, speech: string): Promise<PhoneReply>;
  /**
   * A line in the install's voice when it has one (audio-store.ts), else its
   * text. `fixed`: one of the stock lines, whose audio may be reused.
   */
  line(text: string, fixed?: boolean): Promise<SpokenLine>;
  /** A one-call token for the media socket's URL. */
  mintStreamToken(providerCallId: string): string;
}

export async function handleCallEvent(event: TelephonyWebhookEvent, ctx: CallFlowContext): Promise<WebhookReply> {
  const { provider, callManager } = ctx;
  let session = callManager.getByProviderCallId(event.callId);
  if (!session) {
    for (const alias of event.aliases) {
      const known = callManager.getByProviderCallId(alias);
      if (!known) continue;
      // The call is now known by the id the provider's API addresses it with.
      if (event.callId) known.providerCallId = event.callId;
      session = known;
      break;
    }
  }
  log.info({ provider: provider.name, event: event.type, callId: session?.id, providerCallId: event.callId, status: event.status }, 'Voice webhook received');

  const language = (await ctx.settings.get('voice.language')) as string | null;
  const locale = telephonyLocale(language);

  if (!session) {
    if (event.type === 'incoming' && event.callId) return acceptOrReject(event, ctx, language, locale);
    // A call this process does not know (it restarted mid-call): nothing can be said on it.
    if (event.type === 'answered' || event.type === 'speech') {
      log.warn({ provider: provider.name, providerCallId: event.callId, event: event.type }, 'Webhook for an unknown call; hanging up');
      return provider.instruct(event.callId, { then: 'hangup', locale });
    }
    return provider.acknowledge();
  }

  switch (event.type) {
    case 'incoming':
      // The provider repeated the webhook of a call that is already being answered.
      return provider.acknowledge();

    case 'ringing':
      callManager.updateStatus(session.id, 'ringing');
      return provider.acknowledge();

    case 'answered':
      return opening(session, ctx, locale);

    case 'speech': {
      const speech = event.speech ?? '';
      log.info({ callId: session.id, speech: speech.slice(0, 200) }, 'Voice speech received');
      const listen = { then: 'listen', callbackUrl: ctx.callbackUrl, locale, reprompt: await reprompt(ctx, language) } satisfies CallInstruction;
      let reply: PhoneReply;
      try {
        reply = await ctx.reply(session, speech);
      } catch (err) {
        log.error({ err, callId: session.id }, 'Phone reply failed');
        return provider.instruct(session.providerCallId, { ...listen, say: await ctx.line(phonePhrase('trouble', language), true) });
      }
      if (reply.endCall) {
        // Say the farewell, then hang up.
        return provider.instruct(session.providerCallId, { say: reply.text ? await ctx.line(reply.text) : undefined, then: 'hangup', locale });
      }
      const say = reply.text ? await ctx.line(reply.text) : await ctx.line(phonePhrase('didNotCatch', language), true);
      return provider.instruct(session.providerCallId, { ...listen, say });
    }

    case 'spoken':
      if (event.after === 'hangup') await provider.endCall(session.providerCallId);
      return provider.acknowledge();

    case 'hangup':
      callManager.updateStatus(session.id, event.status ?? 'ended');
      log.info({ callId: session.id, status: event.status ?? 'ended' }, 'Voice call ended');
      return provider.acknowledge();

    default:
      return provider.acknowledge();
  }
}

/** An inbound call nobody knows yet: the inbound policy decides, then it is answered and greeted. */
async function acceptOrReject(event: TelephonyWebhookEvent, ctx: CallFlowContext, language: string | null, locale: string): Promise<WebhookReply> {
  const { provider, callManager, settings } = ctx;
  const policy = ((await settings.get('voice.inboundPolicy')) as string | null) || 'disabled';
  if (policy === 'disabled') {
    log.info({ provider: provider.name, caller: event.from }, 'Inbound call rejected (policy: disabled)');
    return provider.rejectIncoming(event.callId);
  }
  if (policy === 'allowlist') {
    const allowed = ((await settings.get('voice.inboundAllowFrom')) as string[] | null) || [];
    if (!allowed.includes(event.from)) {
      log.info({ provider: provider.name, caller: event.from }, 'Inbound call rejected (not in allowlist)');
      return provider.rejectIncoming(event.callId);
    }
  }

  const session: CallSession = {
    id: `inbound-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    provider: provider.name,
    providerCallId: event.callId,
    direction: 'inbound',
    from: event.from,
    to: event.to,
    status: 'ringing',
    startedAt: new Date(),
    metadata: {
      mode: 'conversation',
      conversationHistory: [],
      pendingMessage: phonePhrase('greeting', language),
    },
  };
  callManager.create(session);
  log.info({ callId: session.id, provider: provider.name, caller: event.from, policy }, 'Inbound call accepted');

  let answered: boolean;
  try {
    answered = await provider.acceptIncoming(event.callId);
  } catch (err) {
    log.error({ err, callId: session.id }, 'Inbound call could not be answered');
    callManager.updateStatus(session.id, 'failed');
    return provider.acknowledge();
  }
  // Answered out of band: the provider's `answered` webhook opens the call.
  return answered ? opening(session, ctx, locale) : provider.acknowledge();
}

/** The call is connected: say what is pending (the greeting, the message of an outbound call) and go on. */
async function opening(session: CallSession, ctx: CallFlowContext, locale: string): Promise<WebhookReply> {
  const { provider, callManager, settings } = ctx;
  callManager.updateStatus(session.id, 'active');
  const pending = typeof session.metadata.pendingMessage === 'string' ? session.metadata.pendingMessage : '';
  delete session.metadata.pendingMessage;
  const conversation = session.metadata.mode === 'conversation';
  const language = (await settings.get('voice.language')) as string | null;
  // The greeting is the same on every call; an outbound call's message is its own.
  const say = pending ? await ctx.line(pending, pending === phonePhrase('greeting', language)) : undefined;

  // The realtime path: with a public URL and streaming on, an inbound call is
  // handed to the bidirectional media socket (low latency, barge-in) instead
  // of the turn-based loop. Providers without one stay on the loop.
  const streaming = await settings.get('voice.streaming');
  if (session.direction === 'inbound' && conversation && provider.mediaStream && ctx.publicBase && (streaming === true || streaming === 'true')) {
    const token = ctx.mintStreamToken(session.providerCallId);
    const streamUrl = `${ctx.publicBase.replace(/\/+$/, '').replace(/^http/, 'ws')}/voice/media/${provider.name}?token=${token}`;
    log.info({ callId: session.id }, 'Answering with the media stream');
    return provider.instruct(session.providerCallId, { say, then: 'stream', streamUrl, locale, opening: true });
  }

  if (!conversation) return provider.instruct(session.providerCallId, { say, then: 'hangup', locale, opening: true });
  return provider.instruct(session.providerCallId, {
    say, then: 'listen', callbackUrl: ctx.callbackUrl, locale, reprompt: await reprompt(ctx, language), opening: true,
  });
}

/** What is said when the caller stays silent. Stock lines: their audio is made once and reused. */
async function reprompt(ctx: CallFlowContext, language: string | null): Promise<NonNullable<CallInstruction['reprompt']>> {
  const [stillThere, listening] = await Promise.all([
    ctx.line(phonePhrase('stillThere', language), true),
    ctx.line(phonePhrase('listening', language), true),
  ]);
  return { stillThere, listening };
}
