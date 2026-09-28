export function githubRepositoryUrl(remoteUrl: string | null | undefined): string | null {
  const remote = remoteUrl?.trim();
  if (!remote) return null;

  const scpStyle = /^[^@\s]+@github\.com:(.+)$/i.exec(remote);
  let repositoryPath = scpStyle?.[1];
  if (!repositoryPath) {
    try {
      const parsed = new URL(remote);
      if (
        parsed.hostname.toLowerCase() !== "github.com"
        || !["git:", "http:", "https:", "ssh:"].includes(parsed.protocol)
      ) return null;
      repositoryPath = parsed.pathname;
    } catch {
      return null;
    }
  }

  const [owner, name, ...extra] = repositoryPath.replace(/^\/+|\/+$/g, "").split("/");
  const repository = name?.replace(/\.git$/i, "");
  return owner && repository && !extra.length ? `https://github.com/${owner}/${repository}` : null;
}
