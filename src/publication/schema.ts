import { proposalSha } from "../github-proposals.ts";
import { fail } from "./error.ts";
import type { PublicationPolicy, PublicationReceipt } from "./types.ts";

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    return fail(
      "invalid-input",
      "Publication policy/receipt must contain exactly their supported schema fields.",
    );

  return Object.fromEntries(Object.entries(value));
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    return fail(
      "invalid-input",
      "Publication receipts require complete lowercase SHA-256 digests.",
    );

  return value;
}

function assetName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value))
    return fail(
      "invalid-input",
      "Release asset names must be explicit bounded filenames without paths.",
    );

  return value;
}

function imageName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^ghcr\.io\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/u.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  )
    return fail(
      "invalid-input",
      "Publication image destinations require explicit lowercase ghcr.io owner/repository names.",
    );

  return value;
}

function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 100)
    return fail(
      "invalid-input",
      "Publication artifacts must be bounded arrays of at most 100 entries.",
    );

  return value;
}

function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length)
    fail("invalid-input", "Publication policy/receipt has duplicate artifact names.");
}

export function parsePublicationPolicy(value: unknown): PublicationPolicy {
  const item = record(value, ["schemaVersion", "assets", "images"]);
  const assets = list(item.assets).map(assetName).toSorted();
  const images = list(item.images).map(imageName).toSorted();

  if (
    item.schemaVersion !== 1 ||
    assets.length + images.length === 0 ||
    assets.length + images.length > 100
  )
    return fail(
      "invalid-input",
      "Publication policy requires schema 1 and 1–100 explicitly configured artifacts.",
    );

  unique(assets);
  unique(images);

  return { schemaVersion: 1, assets, images };
}

export function parsePublicationReceipt(value: unknown): PublicationReceipt {
  const item = record(value, [
    "schemaVersion",
    "approvalVerificationId",
    "landingSha",
    "assets",
    "images",
  ]);

  if (item.schemaVersion !== 1)
    return fail("invalid-input", "Unsupported publication receipt schema.");

  const assets = list(item.assets)
    .map((entry) => {
      const file = record(entry, ["name", "sha256", "size"]);

      if (typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size <= 0)
        return fail("invalid-input", "Publication asset sizes must be positive safe integers.");

      return { name: assetName(file.name), sha256: sha256(file.sha256), size: file.size };
    })
    .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const images = list(item.images)
    .map((entry) => {
      const image = record(entry, ["name", "digest"]);

      if (typeof image.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(image.digest))
        return fail(
          "invalid-input",
          "Publication image receipts require immutable sha256 digests.",
        );

      return { name: imageName(image.name), digest: image.digest };
    })
    .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  if (assets.length + images.length === 0 || assets.length + images.length > 100)
    return fail("invalid-input", "Publication receipts require 1–100 artifacts.");

  unique(assets.map((file) => file.name));
  unique(images.map((image) => image.name));

  return {
    schemaVersion: 1,
    approvalVerificationId: sha256(item.approvalVerificationId),
    landingSha: proposalSha(item.landingSha),
    assets,
    images,
  };
}
