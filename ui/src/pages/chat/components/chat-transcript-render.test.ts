import { expectDefined } from "@openclaw/normalization-core";
/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveThemeBranding } from "../../../../../packages/gateway-protocol/src/theme.ts";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { currentThemeBranding, setCurrentThemeBranding } from "../../../app/theme-branding.ts";
import { resolveAvatarHat } from "../../../components/agent-avatar-hat.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import {
  interruptedChatHistory,
  interruptedChatCommentary,
} from "../../../test-helpers/interrupted-chat-history.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import * as artworkLoader from "../../plugins/icon-loader.ts";
import { attachHistoryActivity } from "../chat-history-request.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import { render, renderTranscriptSearch } from "../test-helpers/chat-transcript-native.tsx";
import { createChatThreadHarness } from "./chat-message-native.test-support.tsx";
import {
  getTranscriptState,
  toggleTranscriptSearch,
  type ChatThreadProps,
} from "./chat-thread-interactions.ts";
import { transcriptContainer } from "./chat-transcript-fixture.test-support.tsx";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  requireElement,
  resetTranscriptTestDom,
  threadProps,
  transcriptMessage as message,
} from "./chat-transcript.test-support.ts";

const cleanups = new Set<() => void>();
function threadFixture(
  props: ChatThreadProps,
  transcript = createTestTranscript(),
  search = false,
) {
  const container = transcriptContainer();
  const searchContainer = search ? transcriptContainer() : container;
  const thread = createChatThreadHarness(container, transcript);
  const dispose = () => {
    transcript.dispose();
    thread.unmount();
    if (search) {
      render(null, searchContainer);
      searchContainer.remove();
    }
    container.remove();
    cleanups.delete(dispose);
  };
  cleanups.add(dispose);
  const rerender = (start = false) => {
    if (search) {
      render(renderTranscriptSearch(props.paneId), searchContainer);
    }
    thread.render(props);
    if (start) {
      transcript.start();
    }
    transcript.update();
  };
  return { container, searchContainer, transcript, rerender };
}

async function mountThread(props: ChatThreadProps, transcript = createTestTranscript()) {
  const fixture = threadFixture(props, transcript);
  fixture.rerender(true);
  await flushDeferredRowPrune();
  return fixture;
}

async function linkFixture(content: string, changes: Partial<ChatThreadProps> = {}) {
  const onOpenSessionLink = vi.fn();
  const onHistoryIntent = vi.fn();
  const props = threadProps(
    "pane-link",
    "agent:main:main",
    [message("assistant", content, 1_000)],
    {
      onOpenSessionLink,
      onHistoryIntent,
      ...changes,
    },
  );
  return { ...(await mountThread(props)), onOpenSessionLink, onHistoryIntent };
}

function activateLink(link: Element | null, action: string) {
  const event =
    action === "click"
      ? new MouseEvent("click", { bubbles: true, button: 0, cancelable: true })
      : new KeyboardEvent("keydown", { key: action, bubbles: true, cancelable: true });
  link?.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

const node = requireElement;
const textOf = (root: ParentNode, selector: string) => node(root, selector).textContent;
const attr = (root: ParentNode, selector: string, name: string) =>
  node(root, selector).getAttribute(name);
const absent = (root: ParentNode, selector: string) =>
  expect(root.querySelector(selector)).toBeNull();
const session = (key: string, changes: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key,
  kind: "direct",
  updatedAt: 1,
  ...changes,
});

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  vi.useRealTimers();
  resetTranscriptTestDom();
});

it("keeps interrupted commentary visible with tools hidden", async () => {
  const props = threadProps(
    "interrupted",
    "agent:main:dashboard:synthetic",
    attachHistoryActivity(interruptedChatHistory()).messages,
  );
  const { container } = await mountThread(props);
  for (const text of interruptedChatCommentary) {
    expect(container.textContent).toContain(text);
  }
  expect(container.textContent).toContain("Interrupted");
  absent(container, ".chat-activity-group__summary, .chat-working-indicator");
});

it.each([
  ["blob:configured-agent", "gutter", "props"],
  ["🦉", "gutter", "fallback-agent"],
  ["blob:configured-agent", "none", null],
] as const)(
  "keeps avatar %s and %s placement consistent across saved and streaming replies (emoji from %s)",
  async (avatar, avatarPlacement, emojiSource) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const props = threadProps("pane-agent-avatar");
    props.userId = "synthetic-owner";
    props.assistantAvatar = emojiSource === "props" ? "🦉" : avatar;
    props.assistantAvatarUrl = avatar.startsWith("blob:") ? avatar : null;
    if (emojiSource === "fallback-agent") {
      props.currentAgentId = undefined;
      props.fullMessageAgentId = "writer";
      props.assistantAvatar = null;
      props.agents = [
        { id: "main", identity: { avatarUrl: "/avatar/main", emoji: "🦞" } },
        { id: "writer", identity: { emoji: "🦉" } },
      ];
    }
    if (avatarPlacement === "none") {
      props.sessionKey = "agent:main:subagent:avatar-test";
    }
    props.stream = "Reply in progress";
    props.streamStartedAt = 5_000;
    props.runActive = true;
    saveChatSessionScrollPosition(props.paneId, props.sessionKey, {
      scrollTop: 0,
      anchorToEnd: false,
    });
    const { container, rerender } = await mountThread(props, createTestTranscript(props.paneId));
    expect(node(container, ".chat-thread").classList.contains("chat-thread--direct")).toBe(
      avatarPlacement !== "gutter",
    );
    const replies = container.querySelectorAll(".chat-group.assistant");
    expect(replies).toHaveLength(3);
    for (const reply of replies) {
      const slot = reply.querySelector(".chat-avatar-slot, .chat-avatar.assistant");
      if (avatarPlacement !== "gutter") {
        expect(slot).toBeNull();
      } else if (avatar.startsWith("blob:")) {
        expect(slot?.querySelector("img.chat-avatar.assistant")).toMatchObject({
          src: avatar,
          alt: props.assistantName,
        });
        expect(slot?.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("🦉");
      } else {
        expect(slot?.querySelector("img")).toBeNull();
        expect(slot?.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe(avatar);
      }
    }
    if (emojiSource === "props") {
      props.assistantAvatar = "🦊";
      rerender();
      await flushDeferredRowPrune();
      expect(
        [...container.querySelectorAll(".chat-avatar.assistant [data-avatar]")].map((element) =>
          element.getAttribute("data-avatar"),
        ),
      ).toEqual(["🦊", "🦊", "🦊"]);
    }
  },
);

it("refreshes settled avatar hats when only plugin artwork or hat selection changes", async () => {
  const previousBranding = currentThemeBranding();
  vi.spyOn(Date, "now").mockReturnValue(Date.now());
  vi.spyOn(artworkLoader, "fetchPluginThemeArtworkBlobUrl").mockImplementation(
    async ({ url }) => `blob:${url}`,
  );
  let branding = resolveThemeBranding({
    mascot: "claw",
    critters: [],
    avatarHat: "beret",
    artwork: { hats: { beret: { url: "/hat?v=1" } } },
  });
  const agentId = expectDefined(
    Array.from({ length: 100 }, (_, index) => `agent-${index}`).find((id) =>
      resolveAvatarHat(id, branding),
    ),
    "agent wearing a hat",
  );
  const props = threadProps("pane-artwork-refresh", `agent:${agentId}:main`, [
    message("assistant", "A settled reply", 1_000),
  ]);
  props.currentAgentId = agentId;
  props.fullMessageAgentId = agentId;
  props.userId = "synthetic-owner";
  props.assistantAvatar = "🦀";
  props.branding = branding;
  const { container, transcript, rerender } = threadFixture(props);
  const draw = async () => {
    setCurrentThemeBranding(props.branding!);
    rerender();
    await vi.dynamicImportSettled();
    flush();
  };
  try {
    await draw();
    transcript.start();
    expect(attr(container, ".identity-avatar__hat-img", "src")).toBe("blob:/hat?v=1");
    branding = { ...branding, artwork: { hats: { beret: { url: "/hat?v=2" } } } };
    props.branding = branding;
    await draw();
    expect(attr(container, ".identity-avatar__hat-img", "src")).toBe("blob:/hat?v=2");
    props.branding = { ...branding, avatarHat: "crown" };
    await draw();
    expect(container.querySelector(".identity-avatar__hat--crown svg")).not.toBeNull();
    expect(container.querySelector(".identity-avatar__hat-img")).toBeNull();
  } finally {
    setCurrentThemeBranding(previousBranding);
  }
});

it("keeps one inline compaction row through completion and history refresh", async () => {
  const props = threadProps("pane-compaction", undefined, undefined, {
    runWorking: true,
    compactionStatus: {
      phase: "active",
      runId: "compact-run",
      startedAt: 5_000,
      completedAt: null,
    },
  });
  const { container, rerender } = await mountThread(props);
  const marker = requireElement(container, ".chat-compaction");
  const glyph = requireElement(marker, ".chat-compaction__glyph");
  expect(marker.textContent).toContain("Compacting context");
  expect(container.querySelector(".chat-working-indicator")).toBeNull();
  props.compactionStatus = {
    phase: "complete",
    runId: "compact-run",
    startedAt: 5_000,
    completedAt: 6_000,
  };
  rerender();
  expect(container.querySelector(".chat-compaction")).toBe(marker);
  expect(marker.textContent).toContain("Context compacted");
  props.messages = [
    ...props.messages,
    message("custom", "Context compacted", 6_000, {
      customType: "openclaw.context-compaction",
      __openclaw: { id: "compacted-item", runId: "compact-run" },
    }),
  ];
  props.compactionStatus = null;
  rerender();
  expect(container.querySelectorAll(".chat-compaction")).toHaveLength(1);
  expect(container.querySelector(".chat-compaction")).toBe(marker);
  expect(marker.querySelector(".chat-compaction__glyph")).toBe(glyph);
  expect(container.textContent?.match(/Context compacted/g)).toHaveLength(1);
  props.messages = [...props.messages, message("assistant", "Next reply", 9_000)];
  rerender();
  expect(container.querySelector(".chat-compaction")).toBe(marker);
});

it("keeps repeated compactions in one run distinct during history adoption", async () => {
  const persisted = (itemId: string, timestamp: number) =>
    message("custom", "Context compacted", timestamp, {
      customType: "openclaw.context-compaction",
      __openclaw: { id: itemId, runId: "same-run", itemId },
    });
  const props = threadProps("pane-repeated-compaction", "agent:main:main", [
    persisted("first", 1_000),
  ]);
  props.compactionStatus = {
    phase: "active",
    runId: "same-run",
    itemId: "second",
    startedAt: 2_000,
    completedAt: null,
  };
  const { container, rerender } = await mountThread(props);
  const active = requireElement(container, ".chat-compaction--active");
  expect(container.querySelectorAll(".chat-compaction")).toHaveLength(2);
  props.messages = [...props.messages, persisted("second", 3_000)];
  rerender();
  expect(container.querySelectorAll(".chat-compaction")).toHaveLength(2);
  expect(active.isConnected).toBe(true);
  expect(active.classList.contains("chat-compaction--complete")).toBe(true);
  expect(container.querySelector(".chat-compaction--active")).toBeNull();
});

it("keeps exact-run usage visible through final event batching and later corrections", async () => {
  const runId = "watched-run";
  const sessionKey = "global";
  const props = threadProps(
    "pane-run-usage",
    sessionKey,
    [
      message("user", "Check the workspace", 1_000, {
        __openclaw: { idempotencyKey: `${runId}:user` },
      }),
      message("assistant", "Workspace checked", 2_000, { runId }),
    ],
    {
      gatewayClient: createTestGatewayClient(() => null),
      currentAgentId: "first",
      runId,
      runWorking: true,
      runUsageById: new Map([["sibling-run", { outputTokens: 900, seq: 1 }]]),
      selectedSession: session(sessionKey, {
        status: "done",
        lastRunId: "previous-run",
        endedAt: 1,
        runtimeMs: 1,
        outputTokens: 10,
      }),
    },
  );
  const fixture = await mountThread(props);
  const { container } = fixture;
  const rerender = (changes: Partial<ChatThreadProps> = {}) => {
    Object.assign(props, changes);
    fixture.rerender();
  };
  const expectRecap = (text: string) =>
    expect(textOf(container, ".chat-turn-recap")).toContain(text);
  const usage = (id: string, seq: number, outputTokens: number) => {
    props.runUsageById = new Map(props.runUsageById).set(id, { seq, outputTokens });
  };
  expect(container.querySelector(".chat-working-indicator__tokens")).toBeNull();

  usage(runId, 1, 6_900);
  rerender();
  expect(textOf(container, ".chat-working-indicator__tokens")).toBe("6.9k output tokens");
  // The event owner is covered by tool-stream.usage.node.test.ts; render its batched output.
  usage(runId, 2, 6_950);
  rerender({
    runId: null,
    runWorking: false,
    selectedSession: session(sessionKey, {
      ...props.selectedSession,
      lastRunId: runId,
      endedAt: 16_000,
      runtimeMs: 14_000,
    }),
  });
  expectRecap("7k output tokens");
  usage(runId, 4, 7_094);
  rerender();
  expectRecap("7.1k output tokens");
  usage("sibling-run", 2, 1_000);
  rerender();
  expectRecap("7.1k output tokens");
  for (const changes of [
    { currentAgentId: "second" },
    { gatewayClient: createTestGatewayClient(() => null) },
  ]) {
    rerender(changes);
    absent(container, ".chat-turn-recap");
    rerender({ currentAgentId: "first", runId, runWorking: true });
    rerender({ runId: null, runWorking: false });
    expectRecap("7.1k output tokens");
  }
  props.messages = [
    ...props.messages,
    message("assistant", "Background reply", 20_000, { runId: "sibling-run" }),
  ];
  rerender();
  expect(container.querySelector(".chat-turn-recap")).toBeNull();
});

it("renders canonical archive attribution as a timestamped notice without a speech bubble", async () => {
  const sessionKey = "agent:work:main";
  const archivedSession = session("global", {
    kind: "global",
    updatedAt: 2_000,
    archived: true,
    archivedAt: 2_000,
    archivedBy: { type: "human", id: "profile-ada", label: "Ada" },
  });
  const props = threadProps(
    "pane-archived-notice",
    sessionKey,
    [message("user", "Before archive", 1_000), message("assistant", "After archive", 3_000)],
    { selectedSession: archivedSession },
  );
  const { container, rerender } = await mountThread(props);

  const notice = requireElement(container, ".chat-notice");
  expect(notice.textContent).toContain("Archived by Ada");
  expect(notice.dataset.ts).toBe("2000");
  expect(notice.querySelector(".chat-bubble")).toBeNull();
  expect(container.querySelectorAll(".chat-bubble")).toHaveLength(2);
  expect(
    [...container.querySelectorAll(".chat-virtual-row")].map((row) =>
      row.querySelector(".chat-notice") ? "notice" : "message",
    ),
  ).toEqual(["message", "notice", "message"]);

  const variants: [Partial<GatewaySessionRow>, string | null][] = [
    [{ archivedBy: { type: "human", id: "profile-bob" } }, "Archived by profile-bob"],
    [
      { archivedBy: undefined, archiveReason: "active-session-cap" },
      "Automatically archived because the active-session limit was reached",
    ],
    [{ archivedBy: undefined }, null],
    [{ archived: false, archivedAt: undefined, archivedBy: undefined }, null],
  ];
  for (const [changes, text] of variants) {
    props.selectedSession = { ...archivedSession, ...changes };
    rerender();
    if (text === null) {
      expect(container.querySelector(".chat-notice")).toBeNull();
    } else {
      expect(requireElement(container, ".chat-notice").textContent).toContain(text);
    }
  }
});

it.each([
  ["session", "click"],
  ["session", " "],
  ["href", "click"],
  ["href", "Enter"],
] as const)("routes transcript %s links with %j", async (kind, action) => {
  const sessionKey = "agent:roboclaw:dashboard:2139bddb-3211-4641-b993-10f619f124e6";
  const pathname = "/control/chat/main/~key/12345678-90ab-cdef-1234-567890abcdef";
  const sources = {
    session: `Open \`${sessionKey}\``,
    href: `[Open session](${pathname}?view=full#latest)`,
  };
  const { container, onOpenSessionLink, onHistoryIntent } = await linkFixture(sources[kind], {
    basePath: "/control",
  });
  const link = node(container, "a");
  if (kind === "session" && action === "click") {
    link.setAttribute("href", "/chat/roboclaw/2139bddb");
  }
  activateLink(link, action);
  if (kind !== "session" || action !== "click") {
    expect(onHistoryIntent).not.toHaveBeenCalled();
  }
  expect(onOpenSessionLink).toHaveBeenCalledWith(
    kind === "session"
      ? { sessionKey, agentId: "roboclaw" }
      : { namespace: "chat", pathname, search: "?view=full", hash: "#latest" },
  );
});

it("leaves external transcript hrefs to the browser", async () => {
  const { container, onOpenSessionLink } = await linkFixture(
    "[External session](https://example.com/chat/main/~key/12345678)",
  );

  const link = container.querySelector<HTMLAnchorElement>('a[href^="https://example.com/"]');
  const event = new MouseEvent("click", { bubbles: true, button: 0, cancelable: true });
  link?.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(false);
  expect(onOpenSessionLink).not.toHaveBeenCalled();
});
function requireClosest(element: Element, selector: string): HTMLElement {
  return expectDefined(element.closest<HTMLElement>(selector), `closest ${selector}`);
}

function touchPointerUp(element: Element): void {
  const event = new Event("pointerup", { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  element.dispatchEvent(event);
}

function expectMetadata(groups: Element[], expected: boolean[]) {
  expect(groups.map((group) => group.classList.contains("chat-group--meta-revealed"))).toEqual(
    expected,
  );
}

function searchFor(container: HTMLElement, query: string) {
  const input = requireElement(container, "input") as HTMLInputElement;
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("keeps live metadata absent while revealing stored metadata within each transcript", async () => {
  const first = threadFixture(
    threadProps(
      "pane-touch-first",
      "agent:main:first",
      ["First", "Second"].map((text, i) => message("user", text, 1_000 + 500 * i)),
      {
        stream: "Live reply",
        streamStartedAt: 2_000,
      },
    ),
  );
  const second = threadFixture(
    threadProps("touch-second", "agent:main:second", [
      message("assistant", "Other transcript", 3_000),
    ]),
  );
  first.rerender(true);
  second.rerender(true);
  await flushDeferredRowPrune();

  const storedGroup = requireElement(first.container, ".chat-group.user");
  const storedBubble = requireElement(storedGroup, ".chat-bubble");
  const streamBubble = requireElement(first.container, ".chat-bubble.streaming");
  const streamGroup = requireClosest(streamBubble, ".chat-group--with-footer");
  const secondGroup = requireElement(second.container, ".chat-group.assistant");

  storedBubble.dispatchEvent(new Event("pointerup", { bubbles: true }));
  expect(storedGroup.classList.contains("chat-group--meta-revealed")).toBe(false);

  const groups = [storedGroup, streamGroup, secondGroup];
  touchPointerUp(storedBubble);
  expectMetadata(groups, [true, false, false]);
  expect(storedGroup.classList.contains("chat-group--peer")).toBe(false);
  expect(storedGroup.querySelectorAll(".chat-bubble")).toHaveLength(2);
  const touches: [Element, boolean[]][] = [
    [requireElement(storedGroup, ".chat-bubble:last-child"), [false, false, false]],
    [storedBubble, [true, false, false]],
    [streamBubble, [false, true, false]],
    [requireElement(secondGroup, ".chat-bubble"), [false, true, true]],
    [requireElement(secondGroup, ".chat-copy-btn"), [false, true, true]],
    [requireElement(secondGroup, ".chat-bubble"), [false, true, false]],
  ];
  for (const [target, expected] of touches) {
    touchPointerUp(target);
    expectMetadata(groups, expected);
  }
  expect(streamGroup.querySelector(".chat-group-footer")?.childElementCount).toBe(0);
});

it.each([false, true])("keeps completed answer metadata (full history=%s)", async (fullHistory) => {
  vi.useFakeTimers();
  const runId = "answer-timestamp";
  const sessionKey = "agent:main:dashboard:answer-timestamp";
  const startedAt = Date.parse("2026-09-27T08:46:05.653Z");
  const answeredAt = Date.parse("2026-09-27T09:20:57.883Z");
  const text = "Confirmed: Engineers — café 雪 🦞";
  const user = message("user", "Confirm the audience.", startedAt - 1_000, {
    __openclaw: { id: "timestamp-prompt", idempotencyKey: `${runId}:user` },
  });
  const answer = message("assistant", text, answeredAt, {
    stopReason: "stop",
    __openclaw: { id: "timestamp-answer", runId, runTerminal: true },
  });
  const call = { type: "toolCall", id: "ask", name: "ask_user", arguments: {} };
  const work = [
    message("assistant", [call], startedAt, {
      stopReason: "toolUse",
      __openclaw: { id: "timestamp-call", runId },
    }),
    message("toolResult", "Engineers — café 雪 🦞", answeredAt - 1_000, {
      toolCallId: "ask",
      toolName: "ask_user",
      __openclaw: { id: "timestamp-result", runId },
    }),
  ];
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const onSetReply = vi.fn();
  const props = threadProps("timestamp", sessionKey, [user, ...(fullHistory ? work : []), answer], {
    showToolCalls: true,
    onSetReply,
    selectedSession: session(sessionKey, {
      updatedAt: answeredAt,
      status: "done",
      lastRunId: runId,
      runtimeMs: 35 * 60_000 + 17_000,
    }),
  });
  const { container, rerender } = threadFixture(props);
  rerender(true);
  await vi.advanceTimersByTimeAsync(0);
  const group = node(container, ".chat-group.assistant");
  expect(group.querySelectorAll(".chat-group-footer")).toHaveLength(1);
  expect(attr(group, "time", "datetime")).toBe("2026-09-27T09:20:57.883Z");
  node(group, ".chat-copy-btn").click();
  expect(writeText).toHaveBeenLastCalledWith(text);
  node(group, ".chat-reply-btn").click();
  expect(onSetReply).toHaveBeenLastCalledWith(
    expect.objectContaining({ sourceMessageId: "timestamp-answer", text }),
  );
  if (fullHistory) {
    expect(textOf(group, ".chat-work-group")).toContain("Worked for 35 minutes, 17 seconds");
  }
  await vi.advanceTimersByTimeAsync(1_500);
});

it.each(["indexed", "keyed"] as const)(
  "keeps a settled %s stream replyable while search separates its following tool row",
  async (kind) => {
    const paneId = `settled-reply-${kind}`;
    const sessionKey = "agent:main:main";
    const runId = "stream-reply-run";
    const text = "Settled summary";
    const onSetReply = vi.fn();
    const props = {
      ...threadProps(paneId, sessionKey, [
        message("user", "Inspect the workspace", 1_000, {
          __openclaw: { id: "stream-prompt", idempotencyKey: `${runId}:user` },
        }),
      ]),
      runId,
      runActive: true,
      runWorking: true,
      streamStartedAt: 2_000,
      showToolCalls: true,
      onSetReply,
      streamSegments: [
        {
          text,
          ts: 2_000,
          runId,
          ...(kind === "keyed" ? { itemId: "settled-segment" } : {}),
        },
      ],
      toolMessages: [
        message("toolResult", "Tool result", 3_000, {
          toolCallId: "following-read",
          toolName: "read",
          runId,
        }),
      ],
    };
    const { transcript, container, searchContainer, rerender } = threadFixture(
      props,
      createTestTranscript(),
      true,
    );
    rerender();
    absent(searchContainer, "input");
    toggleTranscriptSearch(paneId);
    flush();
    transcript.start();
    const input = node(searchContainer, "input") as HTMLInputElement;
    input.focus();
    getTranscriptState(paneId).search.setQuery(text);
    flush();
    expect(searchContainer.querySelector("input")).toBe(input);
    expect(input.value).toBe(text);
    expect(document.activeElement).toBe(input);
    await flushDeferredRowPrune();

    const bubble = requireElement(container, ".chat-group.assistant .chat-bubble");
    const group = requireClosest(bubble, ".chat-group");
    const tool = requireElement(container, ".chat-group.tool");
    expect(bubble.textContent).toContain(text);
    expect(bubble.classList.contains("streaming")).toBe(false);
    expect(group.querySelector(".chat-group-footer-actions, .chat-reading-indicator")).toBeNull();
    expect(group.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    bubble.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const reply = requireElement(document, '.chat-reply-context-menu [role="menuitem"]');
    expect(reply.textContent).toBe("Reply");
    reply.click();

    expect(onSetReply.mock.calls).toEqual([
      [{ messageId: bubble.dataset.messageId, text, senderLabel: "Molty" }],
    ]);
    getTranscriptState(paneId).search.close();
    flush();
    absent(searchContainer, "input");
  },
);

it.each([true, false])(
  "keeps completed commentary a turn block only outside search results (search %s)",
  async (search) => {
    const paneId = `commentary-${search}`;
    const text = "Checked the workspace layout.";
    const props = threadProps(paneId, "agent:main:main", [
      message("user", "Inspect the workspace", 1_000),
      message("assistant", [{ type: "text", text }], 2_000, {
        openclawStreamFallback: { replacementText: text, source: "segment", itemId: "layout" },
      }),
      message("assistant", "Workspace looks fine.", 3_000),
    ]);
    const { transcript, container, searchContainer, rerender } = threadFixture(
      props,
      createTestTranscript(),
      true,
    );
    if (search) {
      toggleTranscriptSearch(paneId);
    }
    transcript.start();
    rerender();
    if (search) {
      searchFor(searchContainer, "workspace layout");
    }
    await flushDeferredRowPrune();

    const group = expectDefined(
      [...container.querySelectorAll<HTMLElement>(".chat-group.assistant")].find((element) =>
        element.textContent?.includes(text),
      ),
      "commentary group",
    );
    expect(group.classList.contains("chat-group--turn-block")).toBe(!search);
    expect(
      [
        ".chat-group-footer .chat-sender-name",
        ".chat-group-footer .chat-group-timestamp",
        ".chat-group-footer-actions .chat-copy-btn",
      ].map((selector) => group.querySelector(selector) !== null),
    ).toEqual([search, search, search]);
  },
);
