import { runAccountAction } from "./workspace-actions";
import { useEffect, useReducer, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import { InlineMessage } from "../components/ui/inline-message";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { WorkspaceOperations } from "./workspace-operations";
import { PRODUCTS, PRODUCT_NAMES, type Product } from "./workspace-types";
import "./google-workspace.css";

interface Status {
  connected: boolean;
  pending: boolean;
  email: string | null;
  products: Product[];
  error: boolean;
}
interface State {
  status: Status | null;
  clientId: string;
  clientSecret: string;
  products: Product[];
  busy: boolean;
  failed: boolean;
}
type Action =
  | { type: "status"; value: Status }
  | { type: "client"; field: "clientId" | "clientSecret"; value: string }
  | { type: "product"; value: Product }
  | { type: "start" }
  | { type: "finish"; failed: boolean }
  | { type: "clear-secret" };
function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "status":
      return { ...state, status: action.value };
    case "client":
      return { ...state, [action.field]: action.value };
    case "product":
      return {
        ...state,
        products: state.products.includes(action.value)
          ? state.products.filter((product) => product !== action.value)
          : [...state.products, action.value],
      };
    case "start":
      return { ...state, busy: true, failed: false };
    case "finish":
      return { ...state, busy: false, failed: action.failed };
    case "clear-secret":
      return { ...state, clientSecret: "" };
  }
}
export type AccountAction = Action;
export type AccountStatus = Status;

export function GoogleWorkspaceAdvanced() {
  const { t } = useLingui();
  const [state, dispatch] = useReducer(reduce, {
    status: null,
    clientId: "",
    clientSecret: "",
    products: ["docs"],
    busy: false,
    failed: false,
  });
  const live = useRef(false);
  const pending = useRef(false);
  const requestGeneration = useRef(0);
  useEffect(() => {
    live.current = true;
    let disposed = false;
    const generation = requestGeneration.current;
    void invoke<Status>("google_workspace_status")
      .then((value) => {
        if (!disposed && requestGeneration.current === generation)
          dispatch({ type: "status", value });
      })
      .catch(() => {
        if (!disposed && requestGeneration.current === generation)
          dispatch({ type: "finish", failed: true });
      });
    return () => {
      disposed = true;
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (!state.status?.pending) return;
    let disposed = false;
    let polling = false;
    const timer = window.setInterval(() => {
      if (polling) return;
      polling = true;
      const generation = requestGeneration.current;
      void invoke<Status>("google_workspace_status")
        .then((value) => {
          if (!disposed && requestGeneration.current === generation)
            dispatch({ type: "status", value });
        })
        .catch(() => {
          if (!disposed && requestGeneration.current === generation)
            dispatch({ type: "finish", failed: true });
        })
        .finally(() => {
          polling = false;
        });
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [state.status?.pending]);
  const run = (action: () => Promise<void>) =>
    runAccountAction(action, { pending, requestGeneration, live, dispatch });
  return (
    <div
      className="google-workspace-advanced"
      aria-busy={state.busy}
    >
      <SettingsSectionHeader
        title={t`Google Workspace API`}
        description={t`Optional: connect your own Desktop OAuth client only if you need programmatic reads and writes through Google APIs. Signing in on Google’s website does not grant Lattice API access.`}
      />
      <p className="google-setup-note">{t`Enable the selected APIs in your Google Cloud project and add your account as a test user if the consent screen is in testing. Authorization opens in your default browser. Passwords and access tokens never enter this page.`}</p>
      {state.status?.connected && (
        <InlineMessage level="info">
          {t`Connected to Google Workspace`}
          {state.status.email ? ` · ${state.status.email}` : ""}
        </InlineMessage>
      )}
      {(state.failed || state.status?.error) && (
        <InlineMessage level="error">{t`Google Workspace could not complete that action. Check your client configuration, consent and network connection. Existing account credentials are preserved after a failed sign-in.`}</InlineMessage>
      )}
      <fieldset disabled={state.busy || state.status?.pending}>
        <label>
          {t`Desktop OAuth client ID`}
          <Input
            value={state.clientId}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) =>
              dispatch({
                type: "client",
                field: "clientId",
                value: event.target.value,
              })
            }
          />
        </label>
        <label>
          {t`Client secret (optional)`}
          <Input
            type="password"
            value={state.clientSecret}
            autoComplete="off"
            onChange={(event) =>
              dispatch({
                type: "client",
                field: "clientSecret",
                value: event.target.value,
              })
            }
          />
        </label>
        <div className="google-products">
          {PRODUCTS.map((product) => (
            <label key={product}>
              <Checkbox
                checked={state.products.includes(product)}
                onChange={() => dispatch({ type: "product", value: product })}
              />
              {PRODUCT_NAMES[product]}
            </label>
          ))}
        </div>
        <Button
          disabled={!state.clientId.trim() || !state.products.length}
          onClick={() => {
            void run(async () => {
              await invoke("google_workspace_begin", {
                client: {
                  clientId: state.clientId.trim(),
                  clientSecret: state.clientSecret,
                  products: state.products,
                },
              });
              if (live.current) dispatch({ type: "clear-secret" });
            });
          }}
        >
          {state.status?.connected
            ? t`Connect another Google account`
            : t`Sign in with default browser`}
        </Button>
      </fieldset>
      {state.status?.pending && (
        <div className="google-actions">
          <span role="status">{t`Waiting for Google authorization…`}</span>
          <Button
            variant="ghost"
            disabled={state.busy}
            onClick={() => {
              void run(async () => {
                await invoke("google_workspace_cancel");
              });
            }}
          >{t`Cancel`}</Button>
        </div>
      )}
      {state.status?.connected && (
        <Button
          variant="ghost"
          disabled={state.busy}
          onClick={() => {
            void run(async () => {
              await invoke("google_workspace_disconnect");
            });
          }}
        >{t`Disconnect Google Workspace`}</Button>
      )}
      {state.status?.connected &&
        !state.status.pending &&
        !state.status.products.length && (
          <InlineMessage level="info">{t`No product permissions were granted. Reconnect and approve the products you want to use.`}</InlineMessage>
        )}
      {state.status?.connected &&
        !state.status.pending &&
        state.status.products.length > 0 && (
          <WorkspaceOperations
            key={state.status.email ?? "google"}
            products={state.status.products}
          />
        )}
    </div>
  );
}
