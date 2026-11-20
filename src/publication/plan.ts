import { createHash } from "node:crypto";
import type { PublicationAction, PublicationReceipt, PublicationState } from "./types.ts";

export function planPublicationActions(
  state: PublicationState,
  receipt: PublicationReceipt,
  intent: { readonly tag: string; readonly landingSha: string; readonly notes: string },
): readonly PublicationAction[] {
  const { tag, landingSha, notes } = intent;
  const actions: PublicationAction[] = [];

  if (state.tag === null) actions.push({ kind: "create-tag", tag, commitSha: landingSha });
  if (state.release === null)
    actions.push({
      kind: "create-draft-release",
      tag,
      notesSha256: createHash("sha256").update(notes).digest("hex"),
    });

  for (const asset of receipt.assets)
    if (!state.release?.assetIds.some((existing) => existing.name === asset.name))
      actions.push({ kind: "upload-asset", ...asset });

  for (const image of receipt.images)
    if (state.images.find((existing) => existing.name === image.name)?.digest === null)
      actions.push({ kind: "publish-image", ...image, tag });

  if (state.release === null || state.release.draft)
    actions.push({ kind: "publish-release", releaseId: state.release?.id ?? null });

  return actions;
}
