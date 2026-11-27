export type CargoPath = "Cargo.lock" | "Cargo.toml" | `${string}/Cargo.toml`;
export const maxCargoMembers = 25;

export function isCargoManifest(path: string): path is Exclude<CargoPath, "Cargo.lock"> {
  return /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*Cargo\.toml$/u.test(path) && path.length <= 512;
}

export const npmLockPaths = ["package-lock.json", "npm-shrinkwrap.json"] as const;
export type NpmLockPath = (typeof npmLockPaths)[number];
