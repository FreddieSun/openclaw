/* @vitest-environment jsdom */
import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
} from "@openclaw/gateway-client/browser";
import type { CanvasDocumentViewResult } from "@openclaw/gateway-protocol";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { GatewayEventListener } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import {
  bumpCanvasWidgetFrameConnectionGeneration,
  getCanvasWidgetFrameConnectionGeneration,
} from "../lib/chat/canvas-widget-frame-generation.ts";
import { ApplicationProvider } from "../lib/reactive/context.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createApplicationGateway } from "../test-helpers/solid-application-context.tsx";
import { flush } from "../test-helpers/solid-settle.ts";
import type { OpenClawCanvasWidgetView } from "./canvas-widget-view.tsx";
import "./canvas-widget-view.tsx";
import { WIDGET_PROMPT_EVENT } from "./mcp-app-security.ts";

const repeat = (length: number) => "x".repeat(length);
const elementName = "openclaw-canvas-widget-view";
const documentView: CanvasDocumentViewResult = {
  html: "<p>Widget ready</p>",
  sandboxUrl: "/mcp-app-sandbox?frames=none",
  sandboxPort: 8444,
};
type WidgetClient = { request: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>> };
let client: WidgetClient;

type WidgetGatewaySnapshot = Omit<Partial<ApplicationGatewaySnapshot>, "client"> & {
  client: WidgetClient;
};

const gateways = new WeakMap<
  OpenClawCanvasWidgetView,
  {
    snapshot: WidgetGatewaySnapshot;
    gateway: ReturnType<typeof createApplicationGateway>["gateway"];
    notify: () => void;
    emit: GatewayEventListener;
  }
>();

async function settle(view: OpenClawCanvasWidgetView) {
  for (let i = 0; i < 4; i += 1) {
    await view.updateComplete;
    await Promise.resolve();
    flush();
  }
}

function connection(
  view: OpenClawCanvasWidgetView,
  phase: ApplicationGatewaySnapshot["phase"],
  patch: Partial<ApplicationGatewaySnapshot> = {},
) {
  const gateway = gateways.get(view)!;
  bumpCanvasWidgetFrameConnectionGeneration();
  view.connectionGeneration = getCanvasWidgetFrameConnectionGeneration();
  Object.assign(gateway.snapshot, { phase }, patch);
  gateway.notify();
}

async function transition(
  view: OpenClawCanvasWidgetView,
  phase: ApplicationGatewaySnapshot["phase"],
  patch?: Partial<ApplicationGatewaySnapshot>,
) {
  connection(view, phase, patch);
  await settle(view);
}

function mount(
  widgetClient: WidgetClient = client,
  docId = "cv_inline",
  parent: Element | ShadowRoot = document.body,
  operatorScopes?: string[],
) {
  const view = document.createElement(elementName) as OpenClawCanvasWidgetView;
  const fixture = createApplicationGateway();
  const snapshot: WidgetGatewaySnapshot = {
    ...fixture.gateway.snapshot,
    client: widgetClient,
    phase: "connected",
    ...(operatorScopes
      ? { hello: gatewayHelloForMethods(["canvas.document.view"], operatorScopes) }
      : {}),
  };
  // The fixture intentionally exposes only the request method used by this owner.
  fixture.publish(snapshot as unknown as ApplicationGatewaySnapshot);
  fixture.gateway.connection.gatewayUrl = "ws://gateway.example:8443";
  gateways.set(view, {
    snapshot,
    gateway: fixture.gateway,
    notify: () => fixture.publish(fixture.gateway.snapshot),
    emit: fixture.publishEvent,
  });
  const context = {
    gateway: fixture.gateway,
    sessions: {
      subscribeMessages: async (key: string) => ({ key }),
      unsubscribeMessages: async () => {},
    },
  } as unknown as ApplicationContext;
  view.docId = docId;
  view.sessionKey = "agent:main:widget-test";
  view.messageTimestamp = Date.now();
  view.connectionGeneration = getCanvasWidgetFrameConnectionGeneration();
  const container = document.createElement("div");
  parent.append(container);
  mountSolid(
    () =>
      createComponent(ApplicationProvider, {
        host: container,
        value: context,
        children: view,
      }),
    { container },
  );
  return view;
}

async function frameFor(view: OpenClawCanvasWidgetView) {
  await expect
    .poll(() => {
      flush();
      return view.querySelector("iframe");
    })
    .not.toBeNull();
  return view.querySelector("iframe")!;
}

function message(
  frame: HTMLIFrameElement,
  data: unknown,
  ports: MessagePort[] = [],
  origin?: string,
  source: MessageEventSource | null = frame.contentWindow,
) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source,
      origin: origin ?? new URL(frame.src).origin,
      data,
      ports,
    }),
  );
}

async function loaded(docId = "cv_inline", parent: Element | ShadowRoot = document.body) {
  const view = mount(client, docId, parent);
  return { view, frame: await frameFor(view) };
}

function proxyReady(frame: HTMLIFrameElement) {
  message(frame, {
    method: "ui/notifications/sandbox-proxy-ready",
    params: { sandboxUrl: frame.src },
  });
}

function expectRecovering(view: OpenClawCanvasWidgetView) {
  expect(alert(view)).toBeNull();
  expect(notice(view)).toContain("recover automatically");
}

const alert = (view: Element) => view.querySelector('[role="alert"]');
const notice = (view: Element) => view.querySelector('[role="status"]')?.textContent;
function commitWidget(view: OpenClawCanvasWidgetView, sessionKey = view.sessionKey) {
  gateways.get(view)!.emit({
    type: "event",
    event: "session.message",
    payload: { sessionKey, message: { role: "toolResult", toolName: "show_widget" } },
  });
}

describe("Canvas widget view", () => {
  beforeEach(() => {
    client = { request: vi.fn().mockResolvedValue(documentView) };
  });
  afterEach(() => {
    document.body.replaceChildren();
    delete (document as unknown as Record<string, unknown>).activeElement;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("loads authenticated HTML once for concurrent views and waits for the exact isolated proxy", async () => {
    const pending = createDeferred<CanvasDocumentViewResult>();
    client.request.mockImplementation(() => pending.promise);
    const first = mount(client);
    const second = mount(client);
    await expect.poll(() => client.request.mock.calls.length).toBe(1);
    pending.resolve(documentView);
    const frame = await frameFor(first);
    await frameFor(second);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    const ready = {
      method: "ui/notifications/sandbox-proxy-ready",
      params: { sandboxUrl: frame.src },
    };
    message(frame, ready, [], "https://attacker.example");
    message(frame, { ...ready, params: { sandboxUrl: `${frame.src}&stale=1` } });
    expect(post).not.toHaveBeenCalled();
    message(frame, ready);
    await expect
      .poll(() =>
        post.mock.calls.some(([data]) => data.method === "ui/notifications/sandbox-resource-ready"),
      )
      .toBe(true);
    expect(first.documentHtml).toBe(documentView.html);
    message(frame, { type: "openclaw:widget-size", height: 3000 });
    await first.updateComplete;
    expect(frame.style.height).toBe("3000px");
    expect(client.request).toHaveBeenCalledOnce();
    frame.dispatchEvent(new Event("error"));
    await first.updateComplete;
    expectRecovering(first);
    first.remove();
    client.request.mockResolvedValue(documentView);
    await frameFor(mount(client));
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it.each(["generation", "client"])(
    "discards an old connection's read when its %s changes",
    async (change) => {
      const old = createDeferred<CanvasDocumentViewResult>();
      const currentDocument = { ...documentView, html: "<p>New connection</p>" };
      client.request.mockImplementationOnce(() => old.promise).mockResolvedValue(currentDocument);
      const view = mount(client);
      await expect.poll(() => client.request.mock.calls.length).toBe(1);
      const replacement = {
        request: vi.fn().mockResolvedValue(currentDocument),
      };
      if (change === "generation") {
        bumpCanvasWidgetFrameConnectionGeneration();
        view.connectionGeneration = getCanvasWidgetFrameConnectionGeneration();
      } else {
        gateways.get(view)!.snapshot.client = replacement;
        gateways.get(view)!.notify();
      }
      await frameFor(view);
      old.resolve(documentView);
      await settle(view);
      expect(view.documentHtml).toBe("<p>New connection</p>");
    },
  );

  it("shows a failed read and retries without keeping the rejected shared request", async () => {
    client.request.mockRejectedValueOnce(new Error("Widget unavailable"));
    const view = mount();
    await expect
      .poll(() => view.querySelector('[role="alert"]')?.textContent)
      .toContain("Widget unavailable");
    view.querySelector("button")!.click();
    await frameFor(view);
  });

  it("hands scroll intent to its transcript only from the current isolated widget", async () => {
    const thread = document.createElement("div");
    const sibling = document.createElement("div");
    thread.className = sibling.className = "chat-thread";
    document.body.append(thread, sibling);
    const scroll = vi.fn();
    thread.scrollBy = scroll;
    const scrollSibling = vi.fn();
    sibling.scrollBy = scrollSibling;
    const { view, frame } = await loaded("cv_scroll", thread);
    const start = async (target: HTMLIFrameElement) => {
      const post = vi.spyOn(target.contentWindow!, "postMessage");
      proxyReady(target);
      await settle(view);
      const nonce = post.mock.calls.find(([data]) => data.type === "openclaw:widget-board-host")![0]
        .nonce;
      return nonce;
    };
    const nonce = await start(frame);
    const request = { type: "openclaw:widget-scroll", nonce, deltaY: 120 };
    const foreignFrame = document.createElement("iframe");
    foreignFrame.src = frame.src;
    sibling.append(foreignFrame);
    message(frame, request, [], "https://wrong.example");
    message(foreignFrame, request);
    message(frame, { ...request, nonce: "wrong" });
    for (const deltaY of ["120", undefined, Infinity, Number.NaN]) {
      message(frame, { ...request, deltaY });
    }
    expect(scroll).not.toHaveBeenCalled();
    message(frame, request);
    expect(scroll).toHaveBeenCalledWith({ top: 120, behavior: "instant" });
    scroll.mockClear();

    const oldSource = frame.contentWindow;
    view.docId = "cv_scroll_replaced";
    message(frame, request);
    await settle(view);
    const current = await frameFor(view);
    expect(current).not.toBe(frame);
    const currentNonce = await start(current);
    expect(currentNonce).not.toBe(nonce);
    message(current, request);
    message(current, { ...request, nonce: currentNonce }, [], undefined, oldSource);
    expect(scroll).not.toHaveBeenCalled();
    message(current, { ...request, nonce: currentNonce, deltaY: -80 });
    expect(scroll).toHaveBeenCalledWith({ top: -80, behavior: "instant" });
    scroll.mockClear();
    view.remove();
    message(current, { ...request, nonce: currentNonce });
    expect(scroll).not.toHaveBeenCalled();
    expect(scrollSibling).not.toHaveBeenCalled();
  });

  it("opens a guest widget automatically when its result commits", async () => {
    vi.useFakeTimers();
    const pending = createDeferred<CanvasDocumentViewResult>();
    client.request.mockReturnValueOnce(pending.promise);
    const view = mount(client, "cv_inline", document.body, ["operator.sessions.read"]);
    await settle(view);
    pending.reject(
      new GatewayProtocolRequestError({
        code: "UNAVAILABLE",
        message: "Waiting for the widget result.",
        retryable: true,
        details: { type: "canvas_widget_pending" },
      }),
    );
    await settle(view);
    expect(notice(view)).toContain("Waiting for the widget result");
    expect(alert(view)).toBeNull();
    commitWidget(view, "agent:main:another");
    expect(client.request).toHaveBeenCalledOnce();
    commitWidget(view);
    await settle(view);
    expect(view.documentHtml).toBe(documentView.html);
    expect(alert(view)).toBeNull();
  });

  it("replaces an in-flight guest lookup when its result commits", async () => {
    vi.useFakeTimers();
    const stale = createDeferred<CanvasDocumentViewResult>();
    client.request.mockReturnValueOnce(stale.promise);
    const view = mount(client, "cv_inline", document.body, ["operator.sessions.read"]);
    await settle(view);
    commitWidget(view);
    await settle(view);
    stale.reject(new GatewayProtocolRequestError({ code: "FORBIDDEN", message: "Access denied" }));
    await settle(view);
    expect(view.documentHtml).toBe(documentView.html);
    expect(alert(view)).toBeNull();
  });

  it.each(["credential", "session", "denied"])(
    "retires retained content after %s changes",
    async (change) => {
      const { view, frame } = await loaded();
      await transition(view, "reconnecting");
      client.request.mockRejectedValue(
        new GatewayProtocolRequestError({ code: "FORBIDDEN", message: "Access denied" }),
      );
      if (change === "credential") {
        gateways.get(view)!.gateway.connectionRevision += 1;
      }
      if (change === "session") {
        view.sessionKey = "agent:other:session";
      }
      if (change !== "denied") {
        gateways.get(view)!.notify();
        await settle(view);
        expect(view.querySelector("iframe")).toBeNull();
        expect(view.documentHtml).toBeUndefined();
      }
      await transition(view, "connected");
      expect(view.querySelector("iframe")).toBeNull();
      expect(frame.isConnected).toBe(false);
      expect(view.documentHtml).toBeUndefined();
      expect(alert(view)?.textContent).toContain("Access denied");
      expect(view.querySelector("button")).toBeNull();
    },
  );

  it("paces timed-out reads and stops retrying while offline", async () => {
    vi.useFakeTimers();
    const timeout = new GatewayProtocolRequestTimeoutError({
      method: "canvas.document.view",
      timeoutMs: 10_000,
      requestSent: true,
    });
    client.request.mockRejectedValue(timeout);
    const view = mount();
    await settle(view);
    expectRecovering(view);
    await vi.advanceTimersByTimeAsync(999);
    expect(client.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.request).toHaveBeenCalledTimes(2);
    await transition(view, "reconnecting");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.request).toHaveBeenCalledTimes(2);
    client.request.mockResolvedValue(documentView);
    await transition(view, "connected");
    expect(view.querySelector("iframe")).not.toBeNull();
    expect(client.request).toHaveBeenCalledTimes(3);
  });

  it("keeps a slow authenticated read alive after the loading notice", async () => {
    vi.useFakeTimers();
    const slowRead = createDeferred<CanvasDocumentViewResult>();
    client.request.mockReturnValue(slowRead.promise);
    const view = mount();
    view.preferredHeight = 520;
    await settle(view);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(notice(view)).toContain("recover automatically");
    expect(view.querySelector<HTMLElement>('[role="status"]')?.style.minHeight).toBe("520px");
    await vi.advanceTimersByTimeAsync(5_000);
    slowRead.resolve(documentView);
    await settle(view);
    expect(client.request).toHaveBeenCalledOnce();
    expect(view.querySelector("iframe")).not.toBeNull();
  });

  it("retains a known profile through reconnect presence hydration but clears a verified mismatch", async () => {
    const view = mount();
    const owner = { id: "owner" } as ApplicationGatewaySnapshot["selfUser"];
    gateways.get(view)!.snapshot.selfUser = owner;
    const frame = await frameFor(view);
    await transition(view, "reconnecting", { selfUser: null });
    await transition(view, "connected", { selfUser: null });
    expect(view.querySelector("iframe")).toBe(frame);
    gateways.get(view)!.snapshot.selfUser = owner;
    gateways.get(view)!.notify();
    await settle(view);
    expect(view.querySelector("iframe")).toBe(frame);
    gateways.get(view)!.snapshot.selfUser = {
      id: "other",
    } as ApplicationGatewaySnapshot["selfUser"];
    gateways.get(view)!.notify();
    await settle(view);
    expect(view.querySelector("iframe")).not.toBe(frame);
  });

  it.each([
    ["surrogate title", `${repeat(79)}😀tail`, repeat(79), repeat(600), repeat(500)],
    ["surrogate message", "Status", "Status", `${repeat(499)}😀tail`, repeat(499)],
    ["dangling surrogate", "Status", "Status", `${repeat(499)}\ud83d`, `${repeat(499)}\ufffd`],
  ])(
    "bounds script errors and wakes once at the %s boundary",
    async (label, title, expectedTitle, errorMessage, expectedMessage) => {
      const now = 1_800_000_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now);
      const docId = `cv_runtime_error_${label}`;
      const view = mount(client, docId);
      view.messageTimestamp = now - 600_000;
      view.title = title;
      const frame = await frameFor(view);
      const report = {
        type: "openclaw:widget-runtime-error",
        message: errorMessage,
        source: "https://example.test/private/widget.js",
        line: 12,
        column: 7,
      };
      message(frame, report);
      message(frame, report);
      message(frame, { ...report, message: "Another failure" });
      await view.updateComplete;
      expect(client.request).toHaveBeenCalledTimes(2);
      expect(client.request).toHaveBeenLastCalledWith("wake", {
        mode: "now",
        sessionKey: view.sessionKey,
        text: `Inline widget "${expectedTitle}" (${docId}) threw a script error after rendering: ${expectedMessage}, line 12, column 7. Fix the script and show the widget again; if show_widget is unavailable in this turn, reply with the corrected widget code and show it on the next turn.`,
      });
      expect(notice(view)).toBe(`Script error: ${expectedMessage}`);
      view.remove();
      const remount = await frameFor(mount(client, docId));
      message(remount, report);
      expect(client.request).toHaveBeenCalledTimes(3);
    },
  );

  it("ignores stale sessions and malformed errors and omits invalid locations", async () => {
    const { view, frame } = await loaded("cv_runtime_invalid");
    const report = { type: "openclaw:widget-runtime-error", message: "Missing element" };
    message(frame, { ...report, message: { message: "Invalid" } });
    view.sessionKey = "agent:main:changed";
    message(frame, report);
    expect(client.request).toHaveBeenCalledOnce();
    await view.updateComplete;
    const current = await frameFor(view);
    message(current, { ...report, line: Infinity, column: 1.5 });
    await view.updateComplete;
    expect(client.request).toHaveBeenLastCalledWith("wake", {
      mode: "now",
      sessionKey: view.sessionKey,
      text: 'Inline widget "" (cv_runtime_invalid) threw a script error after rendering: Missing element. Fix the script and show the widget again; if show_widget is unavailable in this turn, reply with the corrected widget code and show it on the next turn.',
    });
  });

  it.each([
    { label: "older than ten minutes", ageMs: 600_001 },
    { label: "missing", ageMs: undefined },
    { label: "non-finite", ageMs: Infinity },
  ])(
    "keeps the notice but gates wakes when the message timestamp is $label",
    async ({ label, ageMs }) => {
      const now = 1_800_000_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now);
      const view = mount(client, `cv_runtime_age_${label}`);
      view.messageTimestamp = ageMs === undefined ? undefined : now - ageMs;
      const frame = await frameFor(view);
      message(frame, { type: "openclaw:widget-runtime-error", message: "Missing element" });
      await view.updateComplete;
      expect(notice(view)).toBe("Script error: Missing element");
      expect(client.request.mock.calls.filter(([method]) => method === "wake")).toHaveLength(0);
      expect(view.querySelector("iframe")).toBe(frame);
    },
  );

  it.each(["disconnect", "strict then scripts", "client replacement", "parking"])(
    "gates the focused private prompt channel on %s",
    async (change) => {
      const { view, frame } = await loaded(`cv_prompt_${change}`);
      proxyReady(frame);
      await Promise.resolve();
      let onMessage!: (event: MessageEvent) => void;
      const close = vi.fn();
      const removeEventListener = vi.fn();
      const port = {
        addEventListener: vi.fn((_type, handler) => {
          onMessage = handler;
        }),
        removeEventListener,
        start: vi.fn(),
        postMessage: vi.fn(),
        close,
      } as unknown as MessagePort;
      const received = vi.fn();
      view.addEventListener(WIDGET_PROMPT_EVENT, received);
      message(frame, { type: "openclaw:widget-prompt-offer" }, [port]);
      const prompt = (text: string) =>
        onMessage(
          new MessageEvent("message", {
            data: { type: "openclaw:widget-prompt", prompt: text },
          }),
        );
      prompt("Background");
      expect(received).not.toHaveBeenCalled();
      Object.defineProperty(document, "activeElement", { get: () => frame, configurable: true });
      Object.defineProperty(frame, "checkVisibility", { value: () => true });
      message(frame, { type: "openclaw:widget-prompt", prompt: "Forged window message" });
      expect(received).not.toHaveBeenCalled();
      prompt("Show details");
      expect(received).toHaveBeenCalledOnce();
      expect(client.request).toHaveBeenCalledOnce();
      if (change === "parking") {
        const report = { type: "openclaw:widget-runtime-error", message: "Missing details" };
        view.presentationActive = false;
        prompt("Resume details");
        message(frame, report);
        expect(received).toHaveBeenCalledOnce();
        expect(client.request).toHaveBeenCalledOnce();
        message(frame, { type: "openclaw:widget-size", height: 520 });
        await settle(view);
        expect(frame.style.height).toBe("520px");
        expect(view.querySelector('[role="status"]')).toBeNull();
        expect(close).not.toHaveBeenCalled();
        view.presentationActive = true;
        await settle(view);
        prompt("Resume details");
        expect(received).toHaveBeenCalledTimes(2);
        expect(view.querySelector("iframe")).toBe(frame);
        message(frame, report);
        expect(client.request).toHaveBeenLastCalledWith(
          "wake",
          expect.objectContaining({ sessionKey: view.sessionKey }),
        );
        return;
      }
      if (change === "client replacement") {
        message(frame, { type: "openclaw:widget-runtime-error", message: "Failed to fetch" });
        await transition(view, "reconnecting");
        message(frame, { type: "openclaw:widget-runtime-error", message: "d3 is not defined" });
        expect(client.request).toHaveBeenCalledOnce();
        prompt("Resume details");
        expect(received).toHaveBeenCalledOnce();
        expect(view.querySelector("iframe")).toBe(frame);
        const revalidation = createDeferred<CanvasDocumentViewResult>();
        const currentClient = { request: vi.fn().mockReturnValue(revalidation.promise) };
        gateways.get(view)!.snapshot.client = currentClient;
        await transition(view, "connected");
        prompt("Resume details");
        expect(received).toHaveBeenCalledOnce();
        revalidation.resolve(documentView);
        await settle(view);
        prompt("Resume details");
        expect(received).toHaveBeenCalledTimes(2);
        expect(view.querySelector("iframe")).toBe(frame);
        expect(close).not.toHaveBeenCalled();
        message(frame, { type: "openclaw:widget-runtime-error", message: "Missing details" });
        expect(currentClient.request).toHaveBeenLastCalledWith(
          "wake",
          expect.objectContaining({ sessionKey: view.sessionKey }),
        );
        expect(client.request).toHaveBeenCalledOnce();
        currentClient.request.mockResolvedValue({ ...documentView, html: "<p>Updated bytes</p>" });
        await transition(view, "reconnecting");
        await transition(view, "connected");
        expect(view.querySelector("iframe")).not.toBe(frame);
        expect(view.documentHtml).toBe("<p>Updated bytes</p>");
        return;
      }
      if (change === "disconnect") {
        view.remove();
        await Promise.resolve();
      } else {
        view.allowScripts = false;
      }
      expect(close).toHaveBeenCalledOnce();
      expect(removeEventListener.mock.calls).toContainEqual(
        expect.arrayContaining(["message", onMessage]),
      );
      prompt("Stale port");
      expect(received).toHaveBeenCalledOnce();
      if (change === "strict then scripts") {
        view.allowScripts = true;
      }
      if (change !== "disconnect") {
        await view.updateComplete;
        const replacement = await frameFor(view);
        expect(replacement).not.toBe(frame);
        expect(replacement.src).toBe(frame.src);
        expect(client.request).toHaveBeenCalledOnce();
      }
    },
  );
});
