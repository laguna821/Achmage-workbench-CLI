/** Public repository of the project. Self-hosters may point this at a fork. */
export const REPO_URL = 'https://github.com/shaongitbd/doory'

/** The address of a new GitHub issue with the title and text already filled in. */
export function newIssueUrl(title: string, body: string): string {
  const params = new URLSearchParams()
  if (title) params.set('title', title)
  if (body) params.set('body', body)
  const query = params.toString()
  return `${REPO_URL}/issues/new${query ? `?${query}` : ''}`
}
