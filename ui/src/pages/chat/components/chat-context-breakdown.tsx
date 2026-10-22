import { For, Show, createMemo, onSettled, type Element } from "solid-js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { registerChatDetailsEnglish } from "../../../i18n/locales/en-chat-details.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { sessionContextReportsForGateway } from "../../../lib/session-context-report.ts";
import { showToast } from "../../../lib/toast.ts";
import { buildChatContextCategories } from "./chat-context-breakdown-model.ts";
import "../../../styles/chat/context-breakdown.css";

registerEnglishCatalog(registerChatSessionEnglish);
registerEnglishCatalog(registerChatDetailsEnglish);

export const contextLabelKeys = {
  messages: "contextMessages",
  files: "contextFiles",
  tools: "contextTools",
  skills: "contextSkills",
  system: "contextSystem",
} as const;
export const contextGroupLabelKeys = {
  "agent-workspace": "contextAgentWorkspace",
  "execution-project": "contextProject",
  personal: "contextPersonal",
  other: "contextOtherFiles",
  openclaw: "contextSystemTools",
  mcp: "contextMcpTools",
  client: "contextClientTools",
  "unknown-tools": "contextTools",
} as const;

type ContextReportProps = {
  gateway: ApplicationGateway;
  session: GatewaySessionRow;
  agentId?: string;
  used: number;
  presented?: boolean;
};
type ContextReportSnapshot = ReturnType<ReturnType<typeof sessionContextReportsForGateway>["get"]>;

/** Both presentations consume the same read owner; the callback retains its DOM across updates. */
export function ChatContextReport(
  props: ContextReportProps & {
    children: (read: () => ContextReportSnapshot, refresh: () => Promise<void>) => Element;
  },
) {
  const binding = createMemo(
    () => ({
      gateway: props.gateway,
      sessionKey: props.session.key,
      agentId: props.agentId,
      sessionId: props.session.sessionId,
      model: props.session.activeModel || props.session.model,
      provider: props.session.modelProvider,
    }),
    {
      equals: (a, b) =>
        a.gateway === b.gateway &&
        a.sessionKey === b.sessionKey &&
        a.agentId === b.agentId &&
        a.sessionId === b.sessionId &&
        a.model === b.model &&
        a.provider === b.provider,
    },
  );
  return (
    <Show when={binding()} keyed>
      {(identity) => {
        const owner = {};
        const reports = sessionContextReportsForGateway(identity.gateway);
        const target = () => ({ ...identity, used: props.used });
        const view = projectOwner(reports, (store) => store.get(target()));
        const result = view.read;
        let retained = true;
        onSettled(() => () => {
          retained = false;
          reports.unwatch(owner);
        });
        const demand = createMemo(() => (props.presented !== false ? target() : undefined), {
          equals: (previous, next) => previous?.used === next?.used,
        });
        const refresh = async () => {
          const outcome = await reports.refresh(target());
          if (
            retained &&
            props.presented !== false &&
            (outcome === "failed" || outcome === "offline")
          ) {
            showToast({
              message: t(
                outcome === "offline"
                  ? "chat.sessionDetails.contextOffline"
                  : "chat.sessionDetails.contextError",
              ),
              icon: "alertTriangle",
            });
          }
        };
        return (
          <>
            <Show when={demand()} keyed>
              {(current) => {
                onSettled(() => {
                  reports.watch(owner, current);
                  return () => {
                    if (retained) {
                      reports.watch(owner, current, false);
                    }
                  };
                });
                return null;
              }}
            </Show>
            {props.children(result, refresh)}
          </>
        );
      }}
    </Show>
  );
}

export function ChatContextBreakdown(
  props: ContextReportProps & {
    limit: number;
    approximate?: boolean;
    popover?: boolean;
    loadingFallback?: Element;
  },
) {
  return (
    <ChatContextReport {...props}>
      {(result) => (
        <div class={["chat-context", { "chat-context--popover": props.popover }]}>
          <Show when={!result().loading || result().report} fallback={props.loadingFallback}>
            <Show
              when={result().report}
              fallback={
                <p class="chat-context__note" role="status">
                  {t(
                    result().offline
                      ? "chat.sessionDetails.contextOffline"
                      : result().failed
                        ? "chat.sessionDetails.contextError"
                        : "chat.sessionDetails.contextUnavailable",
                  )}
                </p>
              }
            >
              {(report) => {
                const categories = createMemo(() =>
                  buildChatContextCategories(report(), props.used),
                );
                return (
                  <>
                    <div class="chat-context__bar" aria-hidden="true">
                      <For each={categories()} keyed={(category) => category.id}>
                        {(category) => (
                          <span
                            class={["chat-context__segment", `chat-context__${category().id}`]}
                            style={{
                              width:
                                Math.min(100, ((category().tokens ?? 0) / props.limit) * 100) + "%",
                            }}
                          />
                        )}
                      </For>
                    </div>
                    <div class="chat-context__legend">
                      <For each={categories()} keyed={(category) => category.id}>
                        {(category) => (
                          <div class="chat-context__row" data-context-category={category().id}>
                            <span
                              class={["chat-context__swatch", `chat-context__${category().id}`]}
                              aria-hidden="true"
                            />
                            <span class="chat-context__label">
                              {t("chat.sessionDetails." + contextLabelKeys[category().id])}
                            </span>
                            <span class="chat-context__tokens">
                              {category().tokens === null
                                ? t("chat.sessionDetails.contextUnverified")
                                : "~" + formatCompactTokenCount(category().tokens!)}
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </>
                );
              }}
            </Show>
          </Show>
        </div>
      )}
    </ChatContextReport>
  );
}
