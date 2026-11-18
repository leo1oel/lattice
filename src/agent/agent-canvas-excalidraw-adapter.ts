/* eslint-disable lingui/no-unlocalized-strings -- Every message here is a tool error returned to the Agent model, never rendered by Lattice UI. */

// The Excalidraw-facing half of the agent canvas tools, behind the protocol in
// agent-canvas-tools.ts. Like board-editor.tsx, its only consumer, it loads
// only with the lazy board editor: an eager value import of Excalidraw would
// put the whole package in the startup chunk.
//
// The wire format is the tldraw-era one Synara's tools declare (shape ids
// "shape:<id>", the named colours and fills, the shape type aliases), mapped
// onto Excalidraw elements. The GPUI board implements the same contract.
import {
  CaptureUpdateAction, FONT_FAMILY, convertToExcalidrawElements, newElementWith, restoreElements,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement, ExcalidrawTextElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { isRecord } from "../app-utils";
import type { AgentCanvasAdapter } from "./agent-canvas-tools";
import { toolError } from "./agent-protocol";

const MAX_SHAPES_PER_CALL = 100;
const MAX_ARGUMENT_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 400 * 1024;
const MAX_POINTS = 2_000;
const ID = /^shape:([A-Za-z0-9_-]{1,128})$/;

/** Wire type → the shape it makes, aliases included. */
const TYPES: Record<string, string> = {
  rectangle: "rectangle", geo: "rectangle", triangle: "rectangle", trapezoid: "rectangle", hexagon: "rectangle",
  ellipse: "ellipse", oval: "ellipse", diamond: "diamond", rhombus: "diamond",
  text: "text", note: "note", sticky: "note", arrow: "arrow", line: "line",
  draw: "draw", freedraw: "draw", highlight: "highlight", frame: "frame",
};
const LINEAR = new Set(["arrow", "line", "draw", "highlight"]);
const TEXTUAL = new Set(["rectangle", "ellipse", "diamond", "note", "arrow", "text", "frame"]);

/** Named colour → [stroke, tint, highlight], as the .tldr converter maps them (lattice-core board/tldr/style.rs). */
const COLORS: Record<string, readonly [string, string, string]> = {
  black: ["#1e1e1e", "#e9ecef", "#ced4da"], grey: ["#868e96", "#e9ecef", "#ced4da"],
  "light-violet": ["#9c36b5", "#eebefa", "#e599f7"], violet: ["#6741d9", "#d0bfff", "#9775fa"],
  blue: ["#1971c2", "#a5d8ff", "#4dabf7"], "light-blue": ["#0c8599", "#99e9f2", "#3bc9db"],
  yellow: ["#f08c00", "#ffec99", "#ffd43b"], orange: ["#e8590c", "#ffd8a8", "#ffa94d"],
  green: ["#2f9e44", "#b2f2bb", "#69db7c"], "light-green": ["#099268", "#96f2d7", "#38d9a9"],
  "light-red": ["#c2255c", "#fcc2d7", "#f783ac"], red: ["#e03131", "#ffc9c9", "#ff8787"],
  white: ["#ffffff", "#ffffff", "#ffffff"],
};
const FILLS = new Set(["none", "semi", "solid", "pattern"]);
const INK = "#1e1e1e";
const NOTE = "#ffec99";
const FONT = { fontSize: 20, fontFamily: FONT_FAMILY.Nunito };

type Element = ExcalidrawElement;
type Input = Record<string, unknown>;
type Scene = Map<string, Element>;
type End = "startBinding" | "endBinding";

function finiteNumber(record: Input, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number.`);
  return value;
}

function boundedNumber(record: Input, key: string, min: number, max: number): number | undefined {
  const value = finiteNumber(record, key);
  if (value !== undefined && (value < min || value > max)) throw new Error(`${key} must be between ${min} and ${max}.`);
  return value;
}

/** The element id a wire id names. */
function elementId(value: unknown): string {
  const match = typeof value === "string" ? ID.exec(value) : null;
  if (!match) throw new Error("Shape ids must use the form shape:<letters, numbers, _ or ->.");
  return match[1];
}

const wireId = (id: string) => `shape:${id}`;

function shapeArray(args: Input): Input[] {
  if (!Array.isArray(args.shapes) || args.shapes.length === 0 || args.shapes.length > MAX_SHAPES_PER_CALL) {
    throw new Error(`shapes must contain between 1 and ${MAX_SHAPES_PER_CALL} items.`);
  }
  if (!args.shapes.every(isRecord)) throw new Error("Every shape must be an object.");
  return args.shapes;
}

/** The wire type of an element, images and embeds included for the listing. */
function wireType(element: Element): string {
  const shape = element.customData?.latticeShape;
  if (shape === "note" || shape === "highlight") return shape;
  if (element.type === "freedraw") return "draw";
  if (element.type === "embeddable" || element.type === "iframe") return "embed";
  return element.type;
}

/** A container's label: a text element of its own, which the tools never name. */
const isLabel = (element: Element) => element.type === "text" && element.containerId !== null;

function label(scene: Scene, element: Element): ExcalidrawTextElement | undefined {
  const bound = element.boundElements?.find((entry) => entry.type === "text");
  const text = bound ? scene.get(bound.id) : undefined;
  return text?.type === "text" && !text.isDeleted ? text : undefined;
}

function existing(scene: Scene, id: string): Element {
  const element = scene.get(id);
  if (!element || element.isDeleted || isLabel(element)) throw new Error(`Canvas shape not found: ${wireId(id)}`);
  return element;
}

function assertUnlocked(scene: Scene, element: Element) {
  const frame = element.frameId ? scene.get(element.frameId) : undefined;
  if (element.locked || frame?.locked) throw new Error(`Canvas shape is locked: ${wireId(element.id)}`);
}

function fillOf(element: Element): string {
  if (element.backgroundColor === "transparent") return "none";
  if (element.fillStyle === "solid") return element.backgroundColor === "#ffffff" ? "semi" : "solid";
  return "pattern";
}

function project(scene: Scene, element: Element): Input {
  const text = element.type === "text" ? element.text
    : element.type === "frame" ? element.name ?? undefined
    : label(scene, element)?.text;
  const binding = (end: End) => {
    const value = (element as Partial<Record<End, { elementId: string } | null>>)[end];
    return value ? wireId(value.elementId) : undefined;
  };
  return JSON.parse(JSON.stringify({
    id: wireId(element.id),
    type: wireType(element),
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    rotation: element.angle,
    opacity: element.opacity / 100,
    isLocked: element.locked,
    color: element.strokeColor,
    backgroundColor: element.backgroundColor,
    fill: fillOf(element),
    text,
    points: "points" in element ? element.points.map(([x, y]) => [x, y]) : undefined,
    startBinding: binding("startBinding"),
    endBinding: binding("endBinding"),
    frameId: element.frameId ? wireId(element.frameId) : undefined,
    groupIds: element.groupIds.length > 0 ? element.groupIds : undefined,
    index: element.index ?? undefined,
  })) as Input;
}

/** Stroke, background and fill from `color` and `fill` on a shape of wire type `type`. */
function paint(input: Input, type: string, current?: Element): Input {
  const output: Input = {};
  let tint: string | undefined;
  if (input.color !== undefined) {
    const named = typeof input.color === "string" ? COLORS[input.color] : undefined;
    if (named) tint = type === "highlight" ? named[2] : named[1];
    else if (typeof input.color === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(input.color)) tint = input.color;
    else throw new Error("Unsupported canvas color.");
    if (type === "note") output.backgroundColor = tint;
    else output.strokeColor = type === "highlight" ? tint : named?.[0] ?? input.color;
  }
  if (input.fill !== undefined) {
    if (typeof input.fill !== "string" || !FILLS.has(input.fill)) throw new Error("Unsupported canvas fill.");
    const color = tint ?? (current && current.backgroundColor !== "transparent" ? current.backgroundColor : COLORS.black[1]);
    output.backgroundColor = { none: "transparent", semi: "#ffffff", solid: color, pattern: color }[input.fill];
    output.fillStyle = input.fill === "pattern" ? "hachure" : "solid";
  }
  return output;
}

function textOf(input: Input, type: string): string | undefined {
  if (input.text === undefined) return undefined;
  if (typeof input.text !== "string") throw new Error("text must be a string.");
  if (input.text.length > 50_000) throw new Error("Canvas shape text is too long.");
  if (!TEXTUAL.has(type)) throw new Error(`The ${type} shape type does not accept text.`);
  return input.text;
}

const POINTS_ERROR = `points must hold between 2 and ${MAX_POINTS} [x, y] pairs.`;

function pointsOf(input: Input): [number, number][] | undefined {
  const points = input.points;
  if (points === undefined) return undefined;
  const pair = (point: unknown) => Array.isArray(point) && point.length === 2
    && point.every((value) => typeof value === "number" && Number.isFinite(value));
  if (!Array.isArray(points) || points.length < 2 || points.length > MAX_POINTS || !points.every(pair)) {
    throw new Error(POINTS_ERROR);
  }
  return points as [number, number][];
}

/** Points scaled so their extent is `width` × `height` where those are given. */
function fitPoints(points: readonly (readonly [number, number])[], width?: number, height?: number): [number, number][] {
  const extent = (axis: 0 | 1) => Math.max(...points.map((point) => point[axis])) - Math.min(...points.map((point) => point[axis]));
  const scaleX = width !== undefined && extent(0) > 0 ? width / extent(0) : 1;
  const scaleY = height !== undefined && extent(1) > 0 ? height / extent(1) : 1;
  return points.map(([x, y]) => [x * scaleX, y * scaleY]);
}

type Placement = Input & { width?: number; height?: number };

/** Place, size, rotation, opacity and lock, in Excalidraw's terms. */
function placement(input: Input): Placement {
  if (input.props !== undefined) throw new Error("Raw canvas props are not supported.");
  const output: Placement = {};
  for (const key of ["x", "y"] as const) {
    const value = boundedNumber(input, key, -10_000_000, 10_000_000);
    if (value !== undefined) output[key] = value;
  }
  output.width = boundedNumber(input, "width", 1, 1_000_000);
  output.height = boundedNumber(input, "height", 1, 1_000_000);
  const rotation = boundedNumber(input, "rotation", -Math.PI * 2, Math.PI * 2);
  if (rotation !== undefined) output.angle = rotation;
  const opacity = boundedNumber(input, "opacity", 0, 1);
  if (opacity !== undefined) output.opacity = Math.round(opacity * 100);
  if (input.isLocked !== undefined) {
    if (typeof input.isLocked !== "boolean") throw new Error("isLocked must be a boolean.");
    output.locked = input.isLocked;
  }
  return output;
}

/** The frame `frameId` names; `null` takes the shape out of its frame. */
function frameOf(scene: Scene, input: Input): string | null | undefined {
  if (input.frameId === undefined || input.frameId === null) return input.frameId;
  const id = elementId(input.frameId);
  const frame = scene.get(id);
  if (!frame || frame.isDeleted) throw new Error(`Canvas shape not found: ${wireId(id)}`);
  if (frame.type !== "frame") throw new Error(`Not a frame: ${wireId(id)}`);
  return id;
}

const convert = (skeleton: Input) => convertToExcalidrawElements([skeleton as ExcalidrawElementSkeleton], { regenerateIds: false });

/** The new element, then its label when it has one, for one create input. */
function created(input: Input): Element[] {
  if (typeof input.type !== "string") throw new Error("Each new shape requires a type.");
  const type = TYPES[input.type];
  if (!type) throw new Error(`Unsupported canvas shape type: ${input.type}`);
  const id = input.id === undefined ? crypto.randomUUID().replaceAll("-", "") : elementId(input.id);
  const text = textOf(input, type);
  const { width, height, ...place } = placement(input);
  const colors = paint(input, type);
  const base = { roughness: 0, strokeWidth: 2, x: 0, y: 0, ...place, ...colors, id };
  if (LINEAR.has(type)) {
    const straight: [number, number][] = [[0, 0], [width ?? 100, 0]];
    const points = pointsOf(input) ?? (type === "arrow" || type === "line" ? straight : undefined);
    if (!points) throw new Error(POINTS_ERROR);
    const scaled = fitPoints(points, width, height);
    if (type === "draw" || type === "highlight") {
      const highlight = type === "highlight"
        ? { strokeColor: colors.strokeColor ?? COLORS.yellow[2], opacity: 50, strokeWidth: 4, customData: { latticeShape: "highlight" } }
        : {};
      return restoreElements([{ type: "freedraw", ...base, ...highlight, points: scaled, pressures: [], simulatePressure: true } as never], null);
    }
    return convert({
      type, ...base, endArrowhead: type === "arrow" ? "arrow" : null, points: scaled,
      label: text ? { text, ...FONT } : undefined,
    });
  }
  if (type === "text") return convert({ type, ...base, ...FONT, text: text ?? "" });
  if (type === "frame") return convert({ type, ...base, width: width ?? 400, height: height ?? 300, children: [], name: text ?? null });
  const note = type === "note";
  return convert({
    type: note ? "rectangle" : type, ...base,
    ...(note ? { backgroundColor: colors.backgroundColor ?? NOTE, fillStyle: "solid", strokeColor: "transparent", customData: { latticeShape: "note" } } : {}),
    width: width ?? (note ? 200 : 160), height: height ?? (note ? 200 : 100),
    label: text ? { text, ...FONT, strokeColor: note ? INK : colors.strokeColor } : undefined,
  });
}

/** A new label for `container`, measured and placed by Excalidraw. */
function freshLabel(container: Element, text: string): Element {
  const shape = "points" in container ? { points: container.points } : { width: container.width, height: container.height };
  const ink = container.customData?.latticeShape === "note" ? INK : container.strokeColor;
  const [, made] = convert({
    type: container.type, id: container.id, x: container.x, y: container.y, ...shape,
    label: { text, ...FONT, strokeColor: ink },
  });
  return newElementWith(made, { frameId: container.frameId });
}

/** Points the arrow's `end` at a shape (`null` unbinds it), keeping both sides' records. */
function bind(read: (id: string) => Element | undefined, write: (element: Element) => void, arrowId: string, end: End, value: unknown) {
  if (value === undefined) return;
  const arrow = read(arrowId)! as Element & Partial<Record<End, { elementId: string } | null>>;
  if (arrow.type !== "arrow") throw new Error("Only arrows bind to shapes.");
  const before = arrow[end]?.elementId;
  const previous = before ? read(before) : undefined;
  if (previous) write(newElementWith(previous, { boundElements: (previous.boundElements ?? []).filter((entry) => entry.id !== arrowId) }));
  if (value === null) {
    write(newElementWith(arrow, { [end]: null } as never));
    return;
  }
  const id = elementId(value);
  const target = read(id);
  if (!target || target.isDeleted || isLabel(target)) throw new Error(`Canvas shape not found: ${wireId(id)}`);
  const others = (target.boundElements ?? []).filter((entry) => entry.id !== arrowId);
  write(newElementWith(target, { boundElements: [...others, { id: arrowId, type: "arrow" }] }));
  write(newElementWith(read(arrowId)!, { [end]: { elementId: id, focus: 0, gap: 1 } } as never));
}

/** One update input's changes, written into `changed` over `scene`. */
function update(scene: Scene, changed: Scene, input: Input) {
  const id = elementId(input.id);
  const current = existing(scene, id);
  assertUnlocked(scene, current);
  if (input.type !== undefined) throw new Error("A shape's type cannot be changed.");
  const type = wireType(current);
  const text = textOf(input, type);
  const { width, height, ...place } = placement(input);
  const updates: Input = { ...place, ...paint(input, type, current) };
  if ("points" in current) {
    const points = pointsOf(input);
    if (points || width !== undefined || height !== undefined) updates.points = fitPoints(points ?? current.points, width, height);
  } else {
    if (width !== undefined) updates.width = width;
    if (height !== undefined) updates.height = height;
  }
  const frameId = frameOf(scene, input);
  if (frameId !== undefined) updates.frameId = frameId;
  if (current.type === "text" && text !== undefined) {
    const [measured] = convert({ type: "text", x: 0, y: 0, text, fontSize: current.fontSize, fontFamily: current.fontFamily });
    Object.assign(updates, { text, originalText: text, width: measured.width, height: measured.height });
  }
  if (current.type === "frame" && text !== undefined) updates.name = text;
  const read = (key: string) => changed.get(key) ?? scene.get(key);
  const write = (element: Element) => changed.set(element.id, element);
  write(newElementWith(read(id)!, updates as never));
  const old = label(scene, current);
  if (text !== undefined && current.type !== "text" && current.type !== "frame") {
    if (old) write(newElementWith(old, { isDeleted: true }));
    const container = read(id)!;
    const boundElements = (container.boundElements ?? []).filter((entry) => entry.type !== "text");
    if (text) {
      const fresh = freshLabel(container, text);
      write(fresh);
      boundElements.push({ id: fresh.id, type: "text" });
    }
    write(newElementWith(container, { boundElements }));
  } else if (old) {
    const moved = read(id)!;
    write(newElementWith(old, { x: old.x + moved.x - current.x, y: old.y + moved.y - current.y, frameId: moved.frameId }));
  }
  bind(read, write, id, "startBinding", input.startBinding);
  bind(read, write, id, "endBinding", input.endBinding);
}

export function createExcalidrawAgentCanvasAdapter(
  api: ExcalidrawImperativeAPI,
  canWrite: () => boolean,
): AgentCanvasAdapter {
  const sceneNow = (): Scene => new Map(api.getSceneElementsIncludingDeleted().map((element) => [element.id, element]));
  /** `changed` over the scene, then the elements it adds, as one undoable step saved like an edit. */
  const commit = (scene: Scene, changed: Scene) => {
    const kept = [...scene.values()].map((element) => changed.get(element.id) ?? element);
    const added = [...changed.values()].filter((element) => !scene.has(element.id));
    api.updateScene({ elements: [...kept, ...added] as OrderedExcalidrawElement[], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  };
  const projected = (ids: string[]) => {
    const scene = sceneNow();
    return ids.map((id) => project(scene, existing(scene, id)));
  };
  return {
    execute(action, args) {
      if (JSON.stringify(args).length > MAX_ARGUMENT_BYTES) throw new Error("Canvas tool arguments are too large.");
      if (action === "list") {
        const offset = args.offset === undefined ? 0 : boundedNumber(args, "offset", 0, Number.MAX_SAFE_INTEGER)!;
        const limit = args.limit === undefined ? 20 : boundedNumber(args, "limit", 1, 20)!;
        if (!Number.isInteger(offset) || !Number.isInteger(limit)) throw new Error("offset and limit must be integers.");
        const scene = sceneNow();
        const all = [...scene.values()].filter((element) => !element.isDeleted && !isLabel(element));
        const result = {
          shapes: all.slice(offset, offset + limit).map((element) => project(scene, element)),
          offset,
          nextOffset: Math.min(offset + limit, all.length),
          hasMore: offset + limit < all.length,
          total: all.length,
        };
        if (JSON.stringify(result).length > MAX_RESULT_BYTES) throw new Error("Canvas result is too large; request a smaller page.");
        return result;
      }
      if (!canWrite()) throw toolError("The active canvas is read-only.", "canvas_read_only");
      const scene = sceneNow();
      const changed: Scene = new Map();
      const read = (key: string) => changed.get(key) ?? scene.get(key);
      const write = (element: Element) => changed.set(element.id, element);
      if (action === "create") {
        const inputs = shapeArray(args);
        const made = inputs.map(created);
        const ids = made.map(([element]) => element.id);
        if (new Set(ids).size !== ids.length) throw new Error("Canvas shape ids must be unique.");
        for (const id of ids) if (scene.has(id)) throw new Error(`Canvas shape already exists: ${wireId(id)}`);
        for (const element of made.flat()) write(element);
        const both: Scene = new Map([...scene, ...changed]);
        inputs.forEach((input, index) => {
          const frameId = frameOf(both, input);
          if (frameId) for (const element of made[index]) write(newElementWith(read(element.id)!, { frameId }));
          bind(read, write, ids[index], "startBinding", input.startBinding);
          bind(read, write, ids[index], "endBinding", input.endBinding);
        });
        commit(scene, changed);
        return { shapes: projected(ids) };
      }
      if (action === "update") {
        const inputs = shapeArray(args);
        for (const input of inputs) update(scene, changed, input);
        commit(scene, changed);
        return { shapes: projected(inputs.map((input) => elementId(input.id))) };
      }
      if (!Array.isArray(args.ids) || args.ids.length === 0 || args.ids.length > MAX_SHAPES_PER_CALL) {
        throw new Error(`ids must contain between 1 and ${MAX_SHAPES_PER_CALL} shape ids.`);
      }
      const ids = args.ids.map(elementId);
      if (new Set(ids).size !== ids.length) throw new Error("Canvas shape ids must be unique.");
      const doomed = ids.map((id) => existing(scene, id));
      for (const element of doomed) assertUnlocked(scene, element);
      const gone = new Set(ids);
      for (const element of doomed) {
        write(newElementWith(element, { isDeleted: true }));
        const text = label(scene, element);
        if (text) write(newElementWith(text, { isDeleted: true }));
      }
      // Arrows pointing at a deleted shape come unbound, and shapes forget deleted arrows.
      for (const element of scene.values()) {
        if (gone.has(element.id) || element.isDeleted) continue;
        const ends = element as Element & Partial<Record<End, { elementId: string } | null>>;
        const unbind = (end: End) => (ends[end] && gone.has(ends[end].elementId) ? { [end]: null } : {});
        const bound = element.boundElements?.filter((entry) => !gone.has(entry.id));
        const updates = { ...unbind("startBinding"), ...unbind("endBinding"), ...(bound && bound.length !== element.boundElements!.length ? { boundElements: bound } : {}) };
        if (Object.keys(updates).length > 0) write(newElementWith(element, updates as never));
      }
      commit(scene, changed);
      return { deletedIds: ids.map(wireId) };
    },
  };
}
