export function parseGithubBlobUrl(url: string) {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (!m) throw new Error('无效 GitHub 文件链接');
  return { owner: m[1], repo: m[2], branch: m[3], path: decodeURIComponent(m[4]) };
}
