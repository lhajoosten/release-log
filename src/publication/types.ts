export interface PublicationPolicy {
  readonly schemaVersion: 1;
  readonly assets: readonly string[];
  readonly images: readonly string[];
}

export interface PublicationReceipt {
  readonly schemaVersion: 1;
  readonly approvalVerificationId: string;
  readonly landingSha: string;
  readonly assets: readonly {
    readonly name: string;
    readonly sha256: string;
    readonly size: number;
  }[];
  readonly images: readonly { readonly name: string; readonly digest: string }[];
}

export type PublicationAction =
  | { readonly kind: "create-tag"; readonly tag: string; readonly commitSha: string }
  | { readonly kind: "create-draft-release"; readonly tag: string; readonly notesSha256: string }
  | {
      readonly kind: "upload-asset";
      readonly name: string;
      readonly sha256: string;
      readonly size: number;
    }
  | {
      readonly kind: "publish-image";
      readonly name: string;
      readonly tag: string;
      readonly digest: string;
    }
  | { readonly kind: "publish-release"; readonly releaseId: number | null };

export interface PublicationState {
  readonly tag: { readonly objectSha: string; readonly commitSha: string } | null;
  readonly release: {
    readonly id: number;
    readonly draft: boolean;
    readonly assetIds: readonly { readonly name: string; readonly id: number }[];
  } | null;
  readonly images: readonly { readonly name: string; readonly digest: string | null }[];
}

export interface PublicationInspection {
  readonly schemaVersion: 1;
  readonly mode: "read-only";
  readonly repository: string;
  readonly landingSha: string;
  readonly version: string;
  readonly tag: string;
  readonly approvalVerificationId: string;
  readonly publicationPolicyId: string;
  readonly receiptId: string;
  readonly state: PublicationState;
  readonly actions: readonly PublicationAction[];
  readonly complete: boolean;
  readonly inspectionId: string;
}
