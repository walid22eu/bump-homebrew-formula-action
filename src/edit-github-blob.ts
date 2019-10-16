import { GitHub } from '@actions/github'
import { basename } from 'path'

async function retry<T>(
  times: number,
  delay: number,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (times > 0) {
      return new Promise((resolve): void => {
        setTimeout(() => {
          resolve(retry(times - 1, delay, fn))
        }, delay)
      })
    }
    throw err
  }
}

type Options = {
  owner: string
  repo: string
  filePath: string
  branch?: string
  apiClient: GitHub
  replace: (oldContent: string) => string
  commitMessage?: string
}

export default async function(params: Options): Promise<string> {
  const baseRepo = {
    owner: params.owner,
    repo: params.repo,
  }
  let headRepo = baseRepo
  const filePath = params.filePath
  const api = params.apiClient

  const repoRes = await api.repos.get(baseRepo)
  const baseBranch = params.branch ? params.branch : repoRes.data.default_branch
  let headBranch = baseBranch
  const branchRes = await api.repos.getBranch({
    ...baseRepo,
    branch: baseBranch,
  })

  const needsFork = !repoRes.data.permissions.push
  if (needsFork) {
    const forkRes = await api.repos.createFork(baseRepo)
    headRepo = {
      owner: forkRes.data.owner.login,
      repo: forkRes.data.name,
    }
  }

  const needsPr = needsFork || branchRes.data.protected
  if (needsPr) {
    const timestamp = Math.round(Date.now() / 1000)
    headBranch = `update-${basename(filePath)}-${timestamp}`
  }

  if (needsPr) {
    await retry(needsFork ? 6 : 0, 5000, async () => {
      await api.git.createRef({
        ...headRepo,
        ref: `refs/heads/${headBranch}`,
        sha: branchRes.data.commit.sha,
      })
    })
  }

  const fileRes = await api.repos.getContents({
    ...headRepo,
    path: filePath,
    ref: headBranch,
  })
  const fileData = fileRes.data
  if (Array.isArray(fileData)) {
    throw new Error(`expected '${filePath}' is a file, got a directory`)
  }
  const content = ('content' in fileData && fileData.content) || ''
  const contentBuf = Buffer.from(content, 'base64')

  const oldContent = contentBuf.toString('utf8')
  const newContent = params.replace(oldContent)
  if (newContent == oldContent) {
    throw new Error('no replacements ocurred')
  }

  const commitMessage = params.commitMessage
    ? params.commitMessage
    : `Update ${filePath}`
  const commitRes = await api.repos.createOrUpdateFile({
    ...headRepo,
    path: filePath,
    message: commitMessage,
    content: Buffer.from(newContent).toString('base64'),
    sha: fileData.sha,
    branch: headBranch,
  })

  if (needsPr) {
    const parts = commitMessage.split('\n\n')
    const title = parts[0]
    const body = parts.slice(1).join('\n\n')

    const prRes = await api.pulls.create({
      ...baseRepo,
      base: baseBranch,
      head: `${headRepo.owner}:${headBranch}`,
      title,
      body,
    })
    return prRes.data.html_url
  } else {
    return commitRes.data.commit.html_url
  }
}
