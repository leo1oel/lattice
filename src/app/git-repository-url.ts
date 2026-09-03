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

  const segments = repositoryPath.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
  const repository = segments[1].replace(/\.git$/i, "");
  if (!repository) return null;
  return `https://github.com/${segments[0]}/${repository}`;
}
