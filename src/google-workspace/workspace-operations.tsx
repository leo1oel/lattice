import { runWorkspaceOperation } from "./workspace-actions";
import { useEffect, useReducer, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { InlineMessage } from "../components/ui/inline-message";
import { PRODUCT_NAMES, type Product } from "./workspace-types";

/* eslint-disable lingui/no-unlocalized-strings -- Google API JSON examples are editable protocol input */
const EXAMPLES: Record<Product, unknown> = {
  docs: {
    requests: [
      { insertText: { location: { index: 1 }, text: "Research notes\n" } },
    ],
  },
  sheets: {
    values: [
      ["Experiment", "Score"],
      ["Baseline", 0.9],
    ],
  },
  slides: {
    requests: [
      {
        createSlide: {
          objectId: "lattice_slide",
          slideLayoutReference: { predefinedLayout: "BLANK" },
        },
      },
    ],
  },
  forms: {
    requests: [
      {
        createItem: {
          item: {
            title: "Research question",
            questionItem: {
              question: { required: false, textQuestion: { paragraph: false } },
            },
          },
          location: { index: 0 },
        },
      },
    ],
  },
  calendar: {
    summary: "Research writing",
    start: { dateTime: "2027-01-01T09:00:00+08:00" },
    end: { dateTime: "2027-01-01T10:00:00+08:00" },
  },
};
/* eslint-enable lingui/no-unlocalized-strings */
interface State {
  product: Product;
  resourceId: string;
  itemId: string;
  range: string;
  title: string;
  body: string;
  result: unknown;
  busy: boolean;
  error: boolean;
}
type Action =
  | { type: "product"; value: Product }
  | {
      type: "field";
      field: "resourceId" | "itemId" | "range" | "title" | "body";
      value: string;
    }
  | { type: "start" }
  | { type: "result"; value: unknown }
  | { type: "error" };
/* eslint-disable lingui/no-unlocalized-strings -- Calendar's primary ID and Sheets' A1 range are protocol input */
function initial(product: Product): State {
  return {
    product,
    resourceId: product === "calendar" ? "primary" : "",
    itemId: "",
    range: "A1",
    title: "",
    body: JSON.stringify(EXAMPLES[product], null, 2),
    result: null,
    busy: false,
    error: false,
  };
}
/* eslint-enable lingui/no-unlocalized-strings */
function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "product":
      return initial(action.value);
    case "field":
      return {
        ...state,
        [action.field]: action.value,
        ...(["resourceId", "itemId", "range"].includes(action.field)
          ? { result: null, error: false }
          : {}),
      };
    case "start":
      return { ...state, busy: true, error: false, result: null };
    case "result":
      return { ...state, busy: false, result: action.value };
    case "error":
      return { ...state, busy: false, error: true };
  }
}
export type WorkspaceState = State;
export type WorkspaceAction = Action;

export function WorkspaceOperations({ products }: { products: Product[] }) {
  const { t } = useLingui();
  const [state, dispatch] = useReducer(reduce, products[0] ?? "docs", initial);
  const live = useRef(true);
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const field = (
    name: "resourceId" | "itemId" | "range" | "title" | "body",
    value: string,
  ) => dispatch({ type: "field", field: name, value });
  const openInGoogle = async () => {
    const id = encodeURIComponent(state.resourceId.trim());
    const url =
      state.product === "calendar"
        ? "https://calendar.google.com/calendar/u/0/r"
        : `https://docs.google.com/${({ docs: "document", sheets: "spreadsheets", slides: "presentation", forms: "forms" } as const)[state.product]}/d/${id}/edit`;
    try {
      await openUrl(url);
    } catch {
      dispatch({ type: "error" });
    }
  };
  const run = (operation: string) =>
    runWorkspaceOperation(operation, {
      state,
      pending,
      generation,
      live,
      dispatch,
    });
  return (
    <section
      className="google-api-workspace"
      aria-label={t`Google Workspace operations`}
    >
      <h3>{t`Workspace operations`}</h3>
      <p>{t`Use native API operations below. This panel does not embed Google's full web editors. Writes happen only when you choose Create or Apply update. File listing and PDF export include only files this app can access through Drive.`}</p>
      <fieldset disabled={state.busy}>
        <label>
          {t`Product`}
          <select
            value={state.product}
            onChange={(event) =>
              dispatch({
                type: "product",
                value: event.target.value as Product,
              })
            }
          >
            {products.map((product) => (
              <option key={product} value={product}>
                {PRODUCT_NAMES[product]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {state.product === "calendar" ? t`Calendar ID` : t`Resource ID`}
          <Input
            value={state.resourceId}
            onChange={(event) => field("resourceId", event.target.value)}
            spellCheck={false}
          />
        </label>
        {state.product === "calendar" && (
          <label>
            {t`Event ID (leave blank to list events)`}
            <Input
              value={state.itemId}
              onChange={(event) => field("itemId", event.target.value)}
            />
          </label>
        )}
        {state.product === "sheets" && (
          <label>
            {t`Cell range`}
            <Input
              value={state.range}
              onChange={(event) => field("range", event.target.value)}
            />
          </label>
        )}
        <div className="google-actions">
          <Button
            disabled={!state.resourceId.trim()}
            onClick={() => {
              void openInGoogle();
            }}
          >{t`Open in Google`}</Button>
          <Button
            onClick={() => {
              void run("list");
            }}
          >{t`List accessible resources`}</Button>
          <Button
            disabled={!state.resourceId.trim()}
            onClick={() => {
              void run("read");
            }}
          >{t`Read`}</Button>
          {!["forms", "calendar"].includes(state.product) && (
            <Button
              disabled={!state.resourceId.trim()}
              onClick={() => {
                void run("export");
              }}
            >{t`Export PDF`}</Button>
          )}
          {state.product === "forms" && (
            <Button
              disabled={!state.resourceId.trim()}
              onClick={() => {
                void run("responses");
              }}
            >{t`Read responses`}</Button>
          )}
        </div>
        {state.product !== "calendar" && (
          <label>
            {t`New resource title`}
            <Input
              value={state.title}
              onChange={(event) => field("title", event.target.value)}
            />
          </label>
        )}
        <label>
          {t`Request JSON (advanced)`}
          <Textarea
            rows={8}
            value={state.body}
            spellCheck={false}
            onChange={(event) => field("body", event.target.value)}
          />
        </label>
        {state.product === "calendar" && (
          <p>{t`Calendar writes manage private events. Attendees, invitations and conference creation are not supported.`}</p>
        )}
        <div className="google-actions">
          <Button
            disabled={state.product !== "calendar" && !state.title.trim()}
            onClick={() => {
              void run("create");
            }}
          >{t`Create`}</Button>
          <Button
            disabled={
              !state.resourceId.trim() ||
              (state.product === "calendar" && !state.itemId.trim())
            }
            onClick={() => {
              void run("update");
            }}
          >{t`Apply update`}</Button>
        </div>
      </fieldset>
      {state.busy && <p role="status">{t`Waiting for Google…`}</p>}
      {state.error && (
        <InlineMessage level="error">{t`Google could not complete this operation. Check the resource ID, JSON, account scopes and enabled APIs. No credentials or provider error details are shown here.`}</InlineMessage>
      )}
      {state.result !== null && (
        <pre aria-label={t`Google API response`} tabIndex={0}>
          {JSON.stringify(state.result, null, 2)}
        </pre>
      )}
    </section>
  );
}
