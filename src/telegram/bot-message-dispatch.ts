import { resolveAgentDir } from "../agents/agent-scope.js";
// @ts-nocheck
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveChunkMode } from "../auto-reply/chunk.js";
import { clearHistoryEntriesIfEnabled } from "../auto-reply/reply/history.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { removeAckReactionAfterReply } from "../channels/ack-reactions.js";
import { logAckFailure, logTypingFailure } from "../channels/logging.js";
import { createReplyPrefixContext } from "../channels/reply-prefix.js";
import { createTypingCallbacks } from "../channels/typing.js";
import { OpenClawConfig } from "../config/config.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { danger, logVerbose } from "../globals.js";
import { deliverReplies } from "./bot/delivery.js";
import { resolveTelegramStreamMode } from "./bot/helpers.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { createTelegramEditStream } from "./edit-stream.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

async function resolveStickerVisionSupport(cfg: OpenClawConfig, agentId: string) {
  try {
    const catalog = await loadModelCatalog({ config: cfg });
    const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    if (!entry) {
      return false;
    }
    return modelSupportsVision(entry);
  } catch {
    return false;
  }
}

export const dispatchTelegramMessage = async ({
  context,
  bot,
  cfg,
  runtime,
  replyToMode,
  streamingMode,
  textLimit,
  telegramCfg,
  opts,
  resolveBotTopicsEnabled,
  // oxlint-disable-next-line typescript/no-explicit-any
}: any) => {
  const {
    ctxPayload,
    primaryCtx,
    msg,
    chatId,
    isGroup,
    threadSpec,
    historyKey,
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
  } = context;

  const replyQuoteText =
    ctxPayload.ReplyToIsQuote && ctxPayload.ReplyToBody
      ? ctxPayload.ReplyToBody.trim() || undefined
      : undefined;

  const isPrivateChat = msg.chat.type === "private";
  const resolvedStreamingMode = resolveTelegramStreamMode(telegramCfg);
  const effectiveStreamingMode =
    streamingMode === "off" || streamingMode === "edit" || streamingMode === "partial"
      ? streamingMode
      : resolvedStreamingMode;
  const draftThreadId = threadSpec.id;
  const draftMaxChars = Math.min(textLimit, 4096);
  const blockStreamingAllowed =
    typeof telegramCfg.blockStreaming === "boolean" ? telegramCfg.blockStreaming : true;
  const editStreamingEnabled = effectiveStreamingMode === "edit" && blockStreamingAllowed;
  const canStreamDraft =
    !editStreamingEnabled &&
    effectiveStreamingMode === "partial" &&
    isPrivateChat &&
    typeof draftThreadId === "number" &&
    (await resolveBotTopicsEnabled(primaryCtx));
  const draftStream = canStreamDraft
    ? createTelegramDraftStream({
        api: bot.api,
        chatId,
        draftId: msg.message_id || Date.now(),
        maxChars: draftMaxChars,
        thread: threadSpec,
        log: logVerbose,
        warn: logVerbose,
      })
    : undefined;
  let lastPartialText = "";
  const updateDraftFromPartial = (text?: string) => {
    if (!draftStream || !text) {
      return;
    }
    if (text === lastPartialText) {
      return;
    }
    lastPartialText = text;
    draftStream.update(text);
  };
  const flushDraft = async () => {
    if (!draftStream) {
      return;
    }
    await draftStream.flush();
  };

  const editStream = editStreamingEnabled
    ? createTelegramEditStream({
        api: bot.api,
        chatId,
        thread: threadSpec,
        replyQuoteText,
        isGroup,
        maxChars: draftMaxChars,
        cfg,
        accountId: route.accountId,
        runtime,
        linkPreview: telegramCfg.linkPreview,
        retry: telegramCfg.retry,
      })
    : undefined;
  let editStreamingDisabled = !editStream;
  let editText = "";
  const mergeEditText = (next: string, mode: "block" | "partial") => {
    if (!next) {
      return editText;
    }
    if (!editText) {
      editText = next;
      return editText;
    }
    if (next.startsWith(editText)) {
      editText = next;
      return editText;
    }
    if (editText.startsWith(next)) {
      if (mode === "partial") {
        editText = next;
      }
      return editText;
    }
    editText = mode === "block" ? editText + next : next;
    return editText;
  };

  const disableBlockStreaming = editStreamingEnabled
    ? false
    : effectiveStreamingMode === "off"
      ? true
      : Boolean(draftStream) ||
        (typeof telegramCfg.blockStreaming === "boolean" ? !telegramCfg.blockStreaming : undefined);

  const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: route.accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);
  const handlePartialReply = (payload?: { text?: string }) => {
    const text = payload?.text;
    if (editStream && !editStreamingDisabled && text) {
      const merged = mergeEditText(text, "partial");
      const handled = editStream.update(merged, { source: "partial" });
      if (!handled) {
        editStreamingDisabled = true;
      }
    }
    if (draftStream && text) {
      updateDraftFromPartial(text);
    }
  };

  // Handle uncached stickers: get a dedicated vision description before dispatch
  // This ensures we cache a raw description rather than a conversational response
  const sticker = ctxPayload.Sticker;
  if (sticker?.fileUniqueId && ctxPayload.MediaPath) {
    const agentDir = resolveAgentDir(cfg, route.agentId);
    const stickerSupportsVision = await resolveStickerVisionSupport(cfg, route.agentId);
    let description = sticker.cachedDescription ?? null;
    if (!description) {
      description = await describeStickerImage({
        imagePath: ctxPayload.MediaPath,
        cfg,
        agentDir,
        agentId: route.agentId,
      });
    }
    if (description) {
      // Format the description with sticker context
      const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null]
        .filter(Boolean)
        .join(" ");
      const formattedDesc = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;

      sticker.cachedDescription = description;
      if (!stickerSupportsVision) {
        // Update context to use description instead of image
        ctxPayload.Body = formattedDesc;
        ctxPayload.BodyForAgent = formattedDesc;
        // Clear media paths so native vision doesn't process the image again
        ctxPayload.MediaPath = undefined;
        ctxPayload.MediaType = undefined;
        ctxPayload.MediaUrl = undefined;
        ctxPayload.MediaPaths = undefined;
        ctxPayload.MediaUrls = undefined;
        ctxPayload.MediaTypes = undefined;
      }

      // Cache the description for future encounters
      cacheSticker({
        fileId: sticker.fileId,
        fileUniqueId: sticker.fileUniqueId,
        emoji: sticker.emoji,
        setName: sticker.setName,
        description,
        cachedAt: new Date().toISOString(),
        receivedFrom: ctxPayload.From,
      });
      logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
    }
  }

  const deliveryState = {
    delivered: false,
    skippedNonSilent: 0,
  };

  const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      deliver: async (payload, info) => {
        if (info.kind === "block" && editStream && !editStreamingDisabled) {
          const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
          const text = payload.text;
          if (hasMedia) {
            editStreamingDisabled = true;
            editStream.stop();
          } else if (text && text.trim()) {
            const replyToMessageId = payload.replyToId
              ? Number.parseInt(payload.replyToId, 10)
              : undefined;
            const merged = mergeEditText(text, "block");
            const handled = Number.isFinite(replyToMessageId)
              ? editStream.update(merged, { replyToMessageId })
              : editStream.update(merged);
            if (handled) {
              return;
            }
            editStreamingDisabled = true;
          } else {
            return;
          }
        }
        if (info.kind === "final") {
          await flushDraft();
          draftStream?.stop();
          if (editStream && !editStreamingDisabled) {
            const handled = await editStream.finalize(payload);
            editStream.stop();
            if (handled) {
              deliveryState.delivered = true;
              return;
            }
          }
        }
        const result = await deliverReplies({
          replies: [payload],
          chatId: String(chatId),
          token: opts.token,
          runtime,
          bot,
          replyToMode,
          textLimit,
          thread: threadSpec,
          tableMode,
          chunkMode,
          onVoiceRecording: sendRecordVoice,
          linkPreview: telegramCfg.linkPreview,
          replyQuoteText,
        });
        if (result.delivered) {
          deliveryState.delivered = true;
        }
      },
      onSkip: (_payload, info) => {
        if (info.reason !== "silent") {
          deliveryState.skippedNonSilent += 1;
        }
      },
      onError: (err, info) => {
        runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
      },
      onReplyStart: createTypingCallbacks({
        start: sendTyping,
        onStartError: (err) => {
          logTypingFailure({
            log: logVerbose,
            channel: "telegram",
            target: String(chatId),
            error: err,
          });
        },
      }).onReplyStart,
    },
    replyOptions: {
      skillFilter,
      disableBlockStreaming,
      onPartialReply:
        editStream || draftStream ? (payload) => handlePartialReply(payload) : undefined,
      onModelSelected: (ctx) => {
        prefixContext.onModelSelected(ctx);
      },
    },
  });
  draftStream?.stop();
  editStream?.stop();
  if (editStream?.hasMessage()) {
    deliveryState.delivered = true;
  }
  let sentFallback = false;
  if (!deliveryState.delivered && deliveryState.skippedNonSilent > 0) {
    const result = await deliverReplies({
      replies: [{ text: EMPTY_RESPONSE_FALLBACK }],
      chatId: String(chatId),
      token: opts.token,
      runtime,
      bot,
      replyToMode,
      textLimit,
      thread: threadSpec,
      tableMode,
      chunkMode,
      linkPreview: telegramCfg.linkPreview,
      replyQuoteText,
    });
    sentFallback = result.delivered;
  }

  const hasFinalResponse = queuedFinal || sentFallback || Boolean(editStream?.hasMessage());
  if (!hasFinalResponse) {
    if (isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({ historyMap: groupHistories, historyKey, limit: historyLimit });
    }
    return;
  }
  removeAckReactionAfterReply({
    removeAfterReply: removeAckAfterReply,
    ackReactionPromise,
    ackReactionValue: ackReactionPromise ? "ack" : null,
    remove: () => reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve(),
    onError: (err) => {
      if (!msg.message_id) {
        return;
      }
      logAckFailure({
        log: logVerbose,
        channel: "telegram",
        target: `${chatId}/${msg.message_id}`,
        error: err,
      });
    },
  });
  if (isGroup && historyKey) {
    clearHistoryEntriesIfEnabled({ historyMap: groupHistories, historyKey, limit: historyLimit });
  }
};
