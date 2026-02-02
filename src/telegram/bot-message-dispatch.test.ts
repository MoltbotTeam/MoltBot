import { beforeEach, describe, expect, it, vi } from "vitest";

const createTelegramDraftStream = vi.hoisted(() => vi.fn());
const createTelegramEditStream = vi.hoisted(() => vi.fn());
const dispatchReplyWithBufferedBlockDispatcher = vi.hoisted(() => vi.fn());
const deliverReplies = vi.hoisted(() => vi.fn());

vi.mock("./draft-stream.js", () => ({
  createTelegramDraftStream,
}));

vi.mock("./edit-stream.js", () => ({
  createTelegramEditStream,
}));

vi.mock("../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher,
}));

vi.mock("./bot/delivery.js", () => ({
  deliverReplies,
}));

vi.mock("./sticker-cache.js", () => ({
  cacheSticker: vi.fn(),
  describeStickerImage: vi.fn(),
}));

import { dispatchTelegramMessage } from "./bot-message-dispatch.js";

describe("dispatchTelegramMessage draft streaming", () => {
  beforeEach(() => {
    createTelegramDraftStream.mockReset();
    createTelegramEditStream.mockReset();
    dispatchReplyWithBufferedBlockDispatcher.mockReset();
    deliverReplies.mockReset();
  });

  it("streams drafts in private threads and forwards thread id", async () => {
    const draftStream = {
      update: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    };
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Hello" });
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    const resolveBotTopicsEnabled = vi.fn().mockResolvedValue(true);
    const context = {
      ctxPayload: {},
      primaryCtx: { message: { chat: { id: 123, type: "private" } } },
      msg: {
        chat: { id: 123, type: "private" },
        message_id: 456,
        message_thread_id: 777,
      },
      chatId: 123,
      isGroup: false,
      resolvedThreadId: undefined,
      replyThreadId: 777,
      threadSpec: { id: 777, scope: "dm" },
      historyKey: undefined,
      historyLimit: 0,
      groupHistories: new Map(),
      route: { agentId: "default", accountId: "default" },
      skillFilter: undefined,
      sendTyping: vi.fn(),
      sendRecordVoice: vi.fn(),
      ackReactionPromise: null,
      reactionApi: null,
      removeAckAfterReply: false,
    };

    await dispatchTelegramMessage({
      context,
      bot: { api: {} },
      cfg: {},
      runtime: {},
      replyToMode: "first",
      streamingMode: "partial",
      textLimit: 4096,
      telegramCfg: { streamMode: "partial" },
      opts: {},
      resolveBotTopicsEnabled,
    });

    expect(resolveBotTopicsEnabled).toHaveBeenCalledWith(context.primaryCtx);
    expect(createTelegramDraftStream).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 123,
        thread: { id: 777, scope: "dm" },
      }),
    );
    expect(draftStream.update).toHaveBeenCalledWith("Hello");
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: { id: 777, scope: "dm" },
      }),
    );
  });
});

describe("dispatchTelegramMessage edit streaming", () => {
  beforeEach(() => {
    createTelegramDraftStream.mockReset();
    createTelegramEditStream.mockReset();
    dispatchReplyWithBufferedBlockDispatcher.mockReset();
    deliverReplies.mockReset();
  });

  it("edits a single message as block replies arrive", async () => {
    const editStream = {
      update: vi.fn().mockReturnValue(true),
      finalize: vi.fn().mockResolvedValue(true),
      stop: vi.fn(),
      hasMessage: vi.fn().mockReturnValue(true),
    };
    createTelegramEditStream.mockReturnValue(editStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello " }, { kind: "block" });
      await dispatcherOptions.deliver({ text: "world" }, { kind: "block" });
      await dispatcherOptions.deliver({ text: "Hello world" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    const resolveBotTopicsEnabled = vi.fn().mockResolvedValue(true);
    const context = {
      ctxPayload: {},
      primaryCtx: { message: { chat: { id: 123, type: "private" } } },
      msg: {
        chat: { id: 123, type: "private" },
        message_id: 456,
      },
      chatId: 123,
      isGroup: false,
      resolvedThreadId: undefined,
      replyThreadId: undefined,
      threadSpec: { id: 1, scope: "dm" },
      historyKey: undefined,
      historyLimit: 0,
      groupHistories: new Map(),
      route: { agentId: "default", accountId: "default" },
      skillFilter: undefined,
      sendTyping: vi.fn(),
      sendRecordVoice: vi.fn(),
      ackReactionPromise: null,
      reactionApi: null,
      removeAckAfterReply: false,
    };

    await dispatchTelegramMessage({
      context,
      bot: { api: {} },
      cfg: {},
      runtime: {},
      replyToMode: "first",
      streamingMode: "edit",
      textLimit: 4096,
      telegramCfg: { streamMode: "edit" },
      opts: {},
      resolveBotTopicsEnabled,
    });

    expect(createTelegramEditStream).toHaveBeenCalled();
    expect(editStream.update).toHaveBeenCalledTimes(2);
    expect(editStream.update).toHaveBeenCalledWith("Hello ");
    expect(editStream.update).toHaveBeenCalledWith("Hello world");
    expect(editStream.finalize).toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
  });
});
