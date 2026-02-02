import type { Bot } from "grammy";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { RetryConfig } from "../infra/retry.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createTelegramRetryRunner } from "../infra/retry-policy.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";
import { renderTelegramHtmlText } from "./format.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";
import { editMessageTelegram } from "./send.js";

const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const NOT_MODIFIED_RE = /message is not modified/i;
const TELEGRAM_TEXT_MAX = 4096;

const normalizeText = (text: string) => text.trimEnd();

const getCutoff = (isGroup: boolean, contentLength: number) => {
  if (isGroup) {
    if (contentLength > 1000) return 180;
    if (contentLength > 200) return 120;
    if (contentLength > 50) return 90;
    return 50;
  }
  if (contentLength > 1000) return 90;
  if (contentLength > 200) return 45;
  if (contentLength > 50) return 25;
  return 15;
};

const buildSendParams = (opts: {
  replyToMessageId?: number;
  replyQuoteText?: string;
  thread?: TelegramThreadSpec | null;
}) => {
  const threadParams = buildTelegramThreadParams(opts.thread);
  const params: Record<string, unknown> = {};
  const quoteText = opts.replyQuoteText?.trim();
  if (opts.replyToMessageId) {
    if (quoteText) {
      params.reply_parameters = {
        message_id: Math.trunc(opts.replyToMessageId),
        quote: quoteText,
      };
    } else {
      params.reply_to_message_id = Math.trunc(opts.replyToMessageId);
    }
  }
  if (threadParams) {
    params.message_thread_id = threadParams.message_thread_id;
  }
  return params;
};

export type TelegramEditStream = {
  update: (
    text: string,
    opts?: { replyToMessageId?: number; source?: "block" | "partial" },
  ) => boolean;
  finalize: (payload: ReplyPayload) => Promise<boolean>;
  stop: () => void;
  hasMessage: () => boolean;
};

export function createTelegramEditStream(params: {
  api: Bot["api"];
  chatId: string | number;
  thread?: TelegramThreadSpec | null;
  replyQuoteText?: string;
  isGroup: boolean;
  maxChars: number;
  cfg: OpenClawConfig;
  accountId?: string | null;
  runtime?: RuntimeEnv;
  linkPreview?: boolean;
  retry?: RetryConfig;
}): TelegramEditStream {
  const maxChars = Math.min(
    Math.max(1, Math.floor(params.maxChars || TELEGRAM_TEXT_MAX)),
    TELEGRAM_TEXT_MAX,
  );
  const chatId = String(params.chatId);
  const tableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "telegram",
    accountId: params.accountId ?? undefined,
  });
  const linkPreviewEnabled = params.linkPreview ?? true;
  const linkPreviewOptions = linkPreviewEnabled ? undefined : { is_disabled: true };
  const request = createTelegramRetryRunner({
    configRetry: params.retry,
    verbose: false,
    shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" }),
  });
  const requestWithDiag = <T>(fn: () => Promise<T>, label?: string) =>
    withTelegramApiErrorLogging({
      operation: label ?? "request",
      runtime: params.runtime,
      fn: () => request(fn, label),
    });

  let messageId: number | undefined;
  let lastSentText = "";
  let lastSentLength = 0;
  let pendingText = "";
  let inFlight = false;
  let stopped = false;
  let overflowed = false;
  let forceNext = false;
  let pendingReplyToMessageId: number | undefined;

  const sendMessage = async (text: string) => {
    const htmlText = renderTelegramHtmlText(text, { tableMode });
    const replyToMessageId = pendingReplyToMessageId;
    const sendParams = buildSendParams({
      replyToMessageId,
      replyQuoteText: params.replyQuoteText,
      thread: params.thread,
    });
    const paramsWithPreview = linkPreviewOptions
      ? { ...sendParams, link_preview_options: linkPreviewOptions }
      : sendParams;
    const res = await requestWithDiag(
      () =>
        params.api.sendMessage(chatId, htmlText, {
          parse_mode: "HTML",
          ...paramsWithPreview,
        }),
      "message",
    ).catch(async (err) => {
      const errText = formatErrorMessage(err);
      if (!PARSE_ERR_RE.test(errText)) {
        throw err;
      }
      return await requestWithDiag(
        () =>
          params.api.sendMessage(chatId, text, {
            ...paramsWithPreview,
          }),
        "message-plain",
      );
    });
    return res.message_id;
  };

  const editMessage = async (text: string) => {
    if (!messageId) {
      return;
    }
    try {
      await editMessageTelegram(chatId, messageId, text, {
        api: params.api,
        cfg: params.cfg,
        accountId: params.accountId ?? undefined,
      });
    } catch (err) {
      const errText = formatErrorMessage(err);
      if (!NOT_MODIFIED_RE.test(errText)) {
        throw err;
      }
    }
  };

  const flush = async () => {
    if (stopped || inFlight) {
      return;
    }
    const text = pendingText;
    if (!text) {
      return;
    }
    const trimmed = normalizeText(text);
    if (!trimmed) {
      if (pendingText === text) {
        pendingText = "";
      }
      return;
    }
    if (trimmed.length > maxChars) {
      overflowed = true;
      stopped = true;
      logVerbose(`telegram edit stream stopped (message length ${trimmed.length} > ${maxChars})`);
      return;
    }
    if (trimmed === lastSentText) {
      if (pendingText === text) {
        pendingText = "";
      }
      return;
    }
    const shouldForce = forceNext;
    if (messageId) {
      const cutoff = getCutoff(params.isGroup, trimmed.length);
      if (!shouldForce && trimmed.length - lastSentLength < cutoff) {
        return;
      }
    }

    inFlight = true;
    forceNext = false;
    try {
      if (!messageId) {
        messageId = await sendMessage(trimmed);
      } else {
        await editMessage(trimmed);
      }
      lastSentText = trimmed;
      lastSentLength = trimmed.length;
    } catch (err) {
      const errText = formatErrorMessage(err);
      if (!NOT_MODIFIED_RE.test(errText)) {
        logVerbose(`telegram edit stream update failed: ${errText}`);
      }
    } finally {
      inFlight = false;
    }
    if (pendingText !== text || forceNext) {
      await flush();
    }
  };

  const update = (text: string): boolean => {
    if (stopped) {
      return false;
    }
    const normalized = normalizeText(text);
    if (!normalized.trim()) {
      return false;
    }
    if (normalized.length > maxChars) {
      overflowed = true;
      stopped = true;
      logVerbose(
        `telegram edit stream stopped (message length ${normalized.length} > ${maxChars})`,
      );
      return false;
    }
    pendingText = normalized;
    void flush();
    return true;
  };

  const finalize = async (payload: ReplyPayload) => {
    if (stopped || overflowed) {
      return false;
    }
    if (!payload.text) {
      return false;
    }
    const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
    if (hasMedia) {
      return false;
    }
    pendingText = normalizeText(payload.text);
    if (payload.replyToId && !pendingReplyToMessageId) {
      const parsedReplyId = Number(payload.replyToId);
      if (Number.isFinite(parsedReplyId)) {
        pendingReplyToMessageId = parsedReplyId;
      }
    }
    if (!pendingText.trim()) {
      return false;
    }
    forceNext = true;
    await flush();
    return Boolean(messageId) && !overflowed;
  };

  const stop = () => {
    stopped = true;
    pendingText = "";
  };

  return {
    update: (text: string, opts?: { replyToMessageId?: number; source?: "block" | "partial" }) => {
      if (opts?.replyToMessageId != null && !pendingReplyToMessageId) {
        const parsed = Number(opts.replyToMessageId);
        if (Number.isFinite(parsed)) {
          pendingReplyToMessageId = parsed;
        }
      }
      return update(text);
    },
    finalize,
    stop,
    hasMessage: () => Boolean(messageId),
  };
}
