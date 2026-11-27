function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

/** Verify the exact App-authored commit, including GitHub's signature for web-flow commits. */
export async function verifiedAppCommit(
  evidence: unknown,
  head: string,
  bot: string,
  githubSignature: () => Promise<unknown>,
  repositoryName: string,
): Promise<boolean> {
  const commit = object(evidence);
  const author = object(commit?.author);
  const committer = object(commit?.committer);
  const details = object(commit?.commit);
  if (
    !/^[a-f0-9]{40}$/u.test(head) ||
    commit?.sha !== head ||
    author?.login !== bot ||
    author.type !== "Bot" ||
    object(details?.verification)?.verified !== true
  )
    return false;
  if (committer?.login === bot && committer.type === "Bot") return true;
  if (committer?.login !== "web-flow" || committer.type !== "User" || committer.id !== 19864447)
    return false;
  const result = object(await githubSignature());
  const data = object(result?.data);
  const repository = object(data?.repository);
  const node = object(repository?.object);
  const signature = object(node?.signature);
  return (
    !result?.errors &&
    typeof repository?.nameWithOwner === "string" &&
    repository.nameWithOwner.toLowerCase() === repositoryName.toLowerCase() &&
    node?.oid === head &&
    signature?.isValid === true &&
    signature.wasSignedByGitHub === true &&
    object(signature.signer)?.login === "web-flow"
  );
}

/** Query only the named repository and exact object ID; never interpolate values into the query. */
export async function githubCommitSignature(repository: string, head: string, token: string) {
  const [owner, name, extra] = repository.split("/");
  if (
    !owner ||
    !name ||
    extra ||
    !/^[\w.-]+$/u.test(owner) ||
    !/^[\w.-]+$/u.test(name) ||
    !/^[a-f0-9]{40}$/u.test(head)
  )
    throw new Error("Invalid signature query identity");
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      query:
        "query($owner:String!,$name:String!,$oid:GitObjectID!){repository(owner:$owner,name:$name){nameWithOwner object(oid:$oid){... on Commit{oid signature{isValid wasSignedByGitHub signer{login}}}}}}",
      variables: { owner, name, oid: head },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GitHub signature read failed (${response.status})`);
  return response.json() as Promise<unknown>;
}
