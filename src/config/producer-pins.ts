import { array, invalid, isObject, object, text, unique } from "../evidence/schema.ts";

export function parseProducerPins(value: unknown, allowDeprecatedDigest = false) {
  const pins = array(value, 20, "trusted producer catalog").map((entry) => {
    const hasDigest = allowDeprecatedDigest && isObject(entry) && Object.hasOwn(entry, "digest");
    const { sha, legacy, digest } = object(
      entry,
      hasDigest ? ["sha", "legacy", "digest"] : ["sha", "legacy"],
      "producer pin",
    );
    if (!/^[a-f0-9]{40}$/u.test(text(sha, "producer SHA", 40)) || typeof legacy !== "boolean")
      return invalid("Producer pins require full immutable SHAs and explicit legacy authority.");
    if (hasDigest && !/^[a-f0-9]{64}$/u.test(text(digest, "deprecated image digest", 64)))
      return invalid("Deprecated producer digests must be complete lowercase SHA-256 digests.");
    return { sha: text(sha, "producer SHA", 40), legacy };
  });
  unique(
    pins.map(({ sha }) => sha),
    "producer SHAs",
  );
  return pins;
}
