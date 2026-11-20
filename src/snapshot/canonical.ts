import { invalid, limit } from "../evidence/schema.ts";
import type { ReleaseSnapshot } from "./model.ts";

export const maximumBytes = 16 * 1024 * 1024;

export function canonical(value: unknown): string {
  const chunks: string[] = [];
  const visiting = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  function emit(part: string): void {
    bytes += Buffer.byteLength(part, "utf8");
    if (bytes > maximumBytes) limit("Snapshot exceeds 16 MiB in UTF-8.");
    chunks.push(part);
  }
  function walk(item: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 32)
      limit("Snapshot exceeds the 100000-node or 32-level nesting limit.");
    if (item === null) {
      emit("null");
      return;
    }
    if (typeof item === "string") {
      emit(JSON.stringify(item));
      return;
    }
    if (typeof item === "boolean") {
      emit(String(item));
      return;
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      emit(JSON.stringify(item));
      return;
    }
    if (typeof item !== "object")
      return invalid(
        "Snapshots contain only JSON data; unsupported values are not silently discarded.",
      );
    if (visiting.has(item)) return invalid("Snapshot data must not contain cycles.");
    visiting.add(item);
    if (Array.isArray(item)) {
      emit("[");
      for (const [index, child] of item.entries()) {
        if (index) emit(",");
        walk(child, depth + 1);
      }
      emit("]");
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        return invalid("Snapshot objects must be plain JSON objects.");
      const entries = Object.entries(item).toSorted(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      emit("{");
      for (const [index, [key, child]] of entries.entries()) {
        if (index) emit(",");
        emit(JSON.stringify(key));
        emit(":");
        walk(child, depth + 1);
      }
      emit("}");
    }
    visiting.delete(item);
  }
  walk(value, 0);
  return chunks.join("");
}

export function encodeVerifiedSnapshot(validated: ReleaseSnapshot): string {
  const serialized = canonical(validated) + "\n";
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes)
    return limit("Snapshot exceeds 16 MiB including its final newline.");
  return serialized;
}
