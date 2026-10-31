import { createHash } from 'node:crypto';

const fail = (status, message) => Object.assign(new Error(message), { status });
const workflow = 'story-task.yml';
const workflowPath = `.github/workflows/${workflow}`;
const workflowRef = 'main';
const sharedWorkflows = new Set(['story-task.yml', 'sync-story-sources.yml', 'sync-machine-translations.yml', 'release.yml', 'bootstrap.yml']
  .map(name => `.github/workflows/${name}`));
const runPath = run => typeof run.path === 'string' ? run.path.split('@')[0] : '';
const validStory = id => typeof id === 'string' && id.length <= 160
  && /^adv_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$/.test(id) && !/_short$/i.test(id);

export function storyTaskGroup(directory, scriptId) {
  if (!validStory(scriptId)) throw fail(400, '请选择有效的非 short 剧情章节');
  const story = directory.stories?.[scriptId];
  let node = story && directory.nodes?.[story.group];
  if (!node || story.indexVisible === false || directory.roots.includes(node.id) || node.id.endsWith(':unmapped')) {
    throw fail(404, '此章节暂无可用于批量创建任务的剧情分组');
  }
  // Supplemental event episodes belong to their event; birthdays share the
  // character's group. Main/group chapters and individual cards keep their scope.
  if (node.id.endsWith(':other') || node.parent?.startsWith('hbd:')) node = directory.nodes[node.parent];
  const ids = new Set(), visited = new Set();
  function visit(current) {
    if (!current || visited.has(current.id)) throw fail(503, '剧情分组索引不完整，请更新索引后重试');
    visited.add(current.id);
    for (const id of current.stories) if (validStory(id) && directory.stories[id] && directory.stories[id].indexVisible !== false) ids.add(id);
    for (const child of current.children) visit(directory.nodes[child]);
  }
  visit(node);
  if (!ids.has(scriptId) || ids.size > 200) throw fail(400, '剧情分组范围无效或超过 200 篇');
  const scriptIds = [...ids].sort();
  const sha = createHash('sha256').update(JSON.stringify([node.id, scriptIds])).digest('hex');
  return { id: node.id, label: node.label, count: scriptIds.length, sha, scriptIds };
}

// The browser can request a chapter, never choose an executable workflow or ref.
export function storyTaskActions(gh, owner, repo) {
  const inflight = new Map();
  let serial = Promise.resolve(), recent = null;
  const baseUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const workflowUrl = `${baseUrl}/actions/workflows/${workflow}`;
  const runInfo = run => ({
    runId: run.id,
    url: `${baseUrl}/actions/runs/${run.id}`,
    status: run.status,
    conclusion: run.conclusion || null,
  });
  async function status(session, runId) {
    if (!Number.isSafeInteger(runId) || runId <= 0) throw fail(400, '无效工作流运行编号');
    const run = await gh(session, 'GET', `actions/runs/${runId}`);
    if (!sharedWorkflows.has(runPath(run)) || run.head_branch !== workflowRef
      || (runPath(run) === workflowPath && run.event !== 'workflow_dispatch')) {
      throw fail(403, '此运行不属于协作同步工作流');
    }
    if (run.status === 'completed' && recent?.result.runId === runId) recent = null;
    return runInfo(run);
  }
  async function dispatch(session, group) {
    // Avoid replacing another pending dispatch in the workflow's shared queue.
    const runs = await gh(session, 'GET', `actions/runs?branch=${workflowRef}&per_page=100`);
    const active = runs.workflow_runs.find(run => sharedWorkflows.has(runPath(run)) && run.status !== 'completed');
    if (active) return { state: 'busy', ...runInfo(active) };

    const result = await gh(session, 'POST', `actions/workflows/${workflow}/dispatches`, {
      ref: workflowRef, inputs: { filenames: JSON.stringify(group.scriptIds.map(id => `${id}.csv`)) },
    }, '2026-03-10');
    // Newer API versions return the exact run; tolerate legacy no-content replies.
    const runId = result?.workflow_run_id;
    const accepted = { state: 'requested', runId: Number.isSafeInteger(runId) && runId > 0 ? runId : null,
      url: Number.isSafeInteger(runId) && runId > 0 ? `${baseUrl}/actions/runs/${runId}` : workflowUrl };
    // GitHub's run listing can lag behind dispatch acceptance. Coalesce rapid
    // requests until that listing catches up; failed runs can retry immediately.
    recent = { groupSha: group.sha, result: accepted, expires: Date.now() + 30000 };
    return accepted;
  }
  return {
    status,
    create(session, group, expectedSha) {
      if (group.sha !== expectedSha) throw fail(409, '剧情分组已更新，请刷新分组后重试');
      if (inflight.has(group.sha)) return inflight.get(group.sha);
      const request = serial.then(() => {
        if (recent?.expires > Date.now()) {
          if (recent.groupSha === group.sha) return recent.result;
          if (recent.result.runId) return { ...recent.result, state: 'busy' };
        }
        return dispatch(session, group);
      }).finally(() => inflight.delete(group.sha));
      serial = request.catch(() => {});
      inflight.set(group.sha, request);
      return request;
    },
  };
}
