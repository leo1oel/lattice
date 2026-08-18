// The tldraw-facing half of the agent canvas tools. This module is the only
// place outside board-editor.tsx that value-imports "tldraw" — keep it that
// way. tldraw's barrel has no sideEffects flag, so a single value import from
// an eagerly-loaded module drags the entire ~1.5 MB package (plus its
// prosemirror/tiptap dependencies) into the startup chunk. board-editor.tsx,
// this module's sole consumer, is already behind a dynamic import.
import {
  createShapeId,
  toRichText,
  type Editor,
  type TLCreateShapePartial,
  type TLShape,
  type TLShapeId,
  type TLShapePartial,
} from "tldraw";
import type { AgentCanvasAdapter } from "./agent-canvas-tools";

const MAX_SHAPES_PER_CALL = 100;
const MAX_ARGUMENT_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 400 * 1024;
const ALLOWED_SHAPE_TYPES = new Set([
  "arrow", "draw", "frame", "geo", "highlight", "line", "note", "text",
]);
const GEO_ALIASES = new Set([
  "rectangle", "ellipse", "diamond", "triangle", "trapezoid", "hexagon", "oval", "rhombus",
]);
const COLORS = new Set(["black", "grey", "light-violet", "violet", "blue", "light-blue", "yellow", "orange", "green", "light-green", "light-red", "red", "white"]);
const FILLS = new Set(["none", "semi", "solid", "pattern"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number.`);
  return value;
}

function boundedNumber(record: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = finiteNumber(record, key);
  if (value !== undefined && (value < min || value > max)) throw new Error(`${key} must be between ${min} and ${max}.`);
  return value;
}

function shapeId(value: unknown, options: { required: boolean }): TLShapeId {
  if (value === undefined && !options.required) return createShapeId();
  if (typeof value !== "string" || !/^shape:[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("Shape ids must use the form shape:<letters, numbers, _ or ->.");
  }
  return value as TLShapeId;
}

function shapeArray(args: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(args.shapes) || args.shapes.length === 0 || args.shapes.length > MAX_SHAPES_PER_CALL) {
    throw new Error(`shapes must contain between 1 and ${MAX_SHAPES_PER_CALL} items.`);
  }
  if (!args.shapes.every(isRecord)) throw new Error("Every shape must be an object.");
  return args.shapes;
}

function normalizedProps(input: Record<string, unknown>, type: string, geo?: string): Record<string, unknown> {
  if (input.props !== undefined) throw new Error("Raw canvas props are not supported.");
  const props: Record<string, unknown> = {};
  if (geo) props.geo = geo;
  const width = boundedNumber(input, "width", 1, 1_000_000);
  const height = boundedNumber(input, "height", 1, 1_000_000);
  if (width !== undefined) props.w = width;
  if (height !== undefined) props.h = height;
  if (input.color !== undefined) {
    if (typeof input.color !== "string" || !COLORS.has(input.color)) throw new Error("Unsupported canvas color.");
    props.color = input.color;
  }
  if (input.fill !== undefined) {
    if (typeof input.fill !== "string" || !FILLS.has(input.fill)) throw new Error("Unsupported canvas fill.");
    props.fill = input.fill;
  }
  if (typeof input.text === "string") {
    if (input.text.length > 50_000) throw new Error("Canvas shape text is too long.");
    if (type !== "text" && type !== "note" && type !== "geo") {
      throw new Error(`The ${type} shape type does not accept text.`);
    }
    props.richText = toRichText(input.text);
  }
  return props;
}

function normalizedShapeFields(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of ["x", "y"] as const) {
    const value = boundedNumber(input, key, -10_000_000, 10_000_000);
    if (value !== undefined) output[key] = value;
  }
  const rotation = boundedNumber(input, "rotation", -Math.PI * 2, Math.PI * 2);
  if (rotation !== undefined) output.rotation = rotation;
  const opacity = boundedNumber(input, "opacity", 0, 1);
  if (opacity !== undefined) output.opacity = opacity;
  if (input.isLocked !== undefined) {
    if (typeof input.isLocked !== "boolean") throw new Error("isLocked must be a boolean.");
    output.isLocked = input.isLocked;
  }
  return output;
}

function createPartial(input: Record<string, unknown>): TLCreateShapePartial {
  if (typeof input.type !== "string") throw new Error("Each new shape requires a type.");
  const requestedType = input.type;
  const geo = GEO_ALIASES.has(requestedType) ? requestedType : undefined;
  const type = geo ? "geo" : requestedType;
  if (!ALLOWED_SHAPE_TYPES.has(type)) throw new Error(`Unsupported canvas shape type: ${requestedType}`);
  const partial: Record<string, unknown> = {
    id: shapeId(input.id, { required: false }),
    type,
    props: normalizedProps(input, type, geo),
    ...normalizedShapeFields(input),
  };
  return partial as TLCreateShapePartial;
}

function updatePartial(editor: Editor, input: Record<string, unknown>): TLShapePartial {
  const id = shapeId(input.id, { required: true });
  const current = editor.getShape(id);
  if (!current) throw new Error(`Canvas shape not found: ${id}`);
  if (!ALLOWED_SHAPE_TYPES.has(current.type)) throw new Error(`Unsupported canvas shape type: ${current.type}`);
  if (editor.isShapeOrAncestorLocked(current)) throw new Error(`Canvas shape is locked: ${id}`);
  const partial: Record<string, unknown> = { id, type: current.type, ...normalizedShapeFields(input) };
  const props = normalizedProps(input, current.type);
  if (Object.keys(props).length > 0) partial.props = props;
  return partial as TLShapePartial;
}

function projectShape(shape: TLShape): Record<string, unknown> {
  return JSON.parse(JSON.stringify({
    id: shape.id,
    type: shape.type,
    x: shape.x,
    y: shape.y,
    rotation: shape.rotation,
    opacity: shape.opacity,
    isLocked: shape.isLocked,
    parentId: shape.parentId,
    index: shape.index,
    props: shape.props,
    meta: shape.meta,
  })) as Record<string, unknown>;
}

export function createTldrawAgentCanvasAdapter(
  editor: Editor,
  canWrite: () => boolean,
): AgentCanvasAdapter {
  const writable = () => {
    if (!canWrite()) throw Object.assign(new Error("The active canvas is read-only."), { code: "canvas_read_only" });
  };
  return {
    execute(action, args) {
      if (JSON.stringify(args).length > MAX_ARGUMENT_BYTES) throw new Error("Canvas tool arguments are too large.");
      if (action === "list") {
        const offset = args.offset === undefined ? 0 : boundedNumber(args, "offset", 0, Number.MAX_SAFE_INTEGER)!;
        const limit = args.limit === undefined ? 20 : boundedNumber(args, "limit", 1, 20)!;
        if (!Number.isInteger(offset) || !Number.isInteger(limit)) throw new Error("offset and limit must be integers.");
        const allShapes = editor.getCurrentPageShapes();
        const result = {
          shapes: allShapes.slice(offset, offset + limit).map(projectShape),
          offset,
          nextOffset: Math.min(offset + limit, allShapes.length),
          hasMore: offset + limit < allShapes.length,
          total: allShapes.length,
        };
        if (JSON.stringify(result).length > MAX_RESULT_BYTES) throw new Error("Canvas result is too large; request a smaller page.");
        return result;
      }
      writable();
      if (action === "create") {
        const partials = shapeArray(args).map(createPartial);
        const ids = partials.map((partial) => partial.id!);
        if (new Set(ids).size !== ids.length) throw new Error("Canvas shape ids must be unique.");
        for (const id of ids) if (editor.getShape(id)) throw new Error(`Canvas shape already exists: ${id}`);
        editor.createShapes(partials);
        const created = ids.map((id) => editor.getShape(id));
        if (created.some((shape) => !shape)) throw new Error("tldraw did not create every requested shape.");
        return { shapes: created.filter(Boolean).map((shape) => projectShape(shape!)) };
      }
      if (action === "update") {
        const partials = shapeArray(args).map((shape) => updatePartial(editor, shape));
        editor.updateShapes(partials);
        return { shapes: partials.map((partial) => editor.getShape(partial.id)!).filter(Boolean).map(projectShape) };
      }
      if (!Array.isArray(args.ids) || args.ids.length === 0 || args.ids.length > MAX_SHAPES_PER_CALL) {
        throw new Error(`ids must contain between 1 and ${MAX_SHAPES_PER_CALL} shape ids.`);
      }
      const ids = args.ids.map((id) => shapeId(id, { required: true }));
      if (new Set(ids).size !== ids.length) throw new Error("Canvas shape ids must be unique.");
      for (const id of ids) {
        const shape = editor.getShape(id);
        if (!shape) throw new Error(`Canvas shape not found: ${id}`);
        if (editor.isShapeOrAncestorLocked(shape)) throw new Error(`Canvas shape is locked: ${id}`);
      }
      editor.deleteShapes(ids);
      if (ids.some((id) => editor.getShape(id))) throw new Error("tldraw did not delete every requested shape.");
      return { deletedIds: ids };
    },
  };
}
