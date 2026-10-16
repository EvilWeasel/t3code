'use strict';
const CONTEXT = 'weasel/nightly-dispatch';
const WORKFLOW = 'weasel-release.yml';
const REPOSITORY = 'morrowbyte/t3code';
const assert = (ok, category) => { if (!ok) throw Error(category); };

function validateTrigger(run, repository) {
  assert(repository === REPOSITORY && (run?.repository === undefined || run.repository.full_name === REPOSITORY) && run?.head_repository?.full_name === REPOSITORY, 'foreign-ci-run');
  assert(run.event === 'push' && run.head_branch === 'main' && run.path === '.github/workflows/weasel-ci.yml', 'not-normal-main-push-ci');
  assert(run.status === 'completed' && run.conclusion === 'success', 'ci-not-successful');
  assert(/^[0-9a-f]{40}$/.test(run.head_sha) && Number.isSafeInteger(run.id) && run.id > 0, 'invalid-ci-identity');
  return run.head_sha;
}

function decideDispatch({source, main, statuses, runs, runCount, releases}) {
  assert(Array.isArray(statuses) && statuses.length < 100, 'status-window-ambiguous');
  assert(Array.isArray(runs) && runCount === runs.length && runCount <= 100, 'release-run-window-ambiguous');
  assert(Array.isArray(releases),'published-release-observation-required');
  const published=releases.find(r=>r.target_commitish===source && r.draft===false && typeof r.published_at==='string');
  if(published) return {action:'skip',reason:'source-already-published',releaseId:published.id};
  const marker = statuses.find(s => s.context === CONTEXT);
  const relevant = runs.filter(r => r.head_sha === source && r.path === '.github/workflows/weasel-release.yml' && r.event === 'workflow_dispatch' && r.head_branch === 'main');
  assert(relevant.length <= 1, 'duplicate-existing-nightly-runs');
  if (relevant.length === 1) return {action:'reconcile', run:relevant[0]};
  // Any durable marker means a dispatch might have reached GitHub. Absence of
  // a run is not permission to repeat an uncertain side effect.
  if (marker) return {action:'stop', reason:'existing-intent-without-reconciled-run'};
  if (main !== source) return {action:'skip', reason:'main-advanced-before-dispatch'};
  return {action:'dispatch'};
}

async function nightlyAfterCI({github, context, core}) {
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const source = validateTrigger(context.payload.workflow_run, repository);
  const repo = context.repo;
  // Re-read the live run and its exact attempt rather than trusting only the
  // workflow_run delivery or a skipped repository-conditional job.
  const {data:ci} = await github.rest.actions.getWorkflowRun({...repo, run_id:context.payload.workflow_run.id});
  assert(validateTrigger(ci, repository) === source && ci.repository?.full_name === REPOSITORY, 'live-ci-source-mismatch');
  assert(Number.isSafeInteger(ci.run_attempt) && ci.run_attempt > 0, 'invalid-ci-attempt');
  const {data:jobs} = await github.rest.actions.listJobsForWorkflowRunAttempt({...repo, run_id:ci.id, attempt_number:ci.run_attempt, per_page:100});
  assert(jobs.total_count <= 100 && jobs.jobs.length === jobs.total_count, 'incomplete-ci-jobs');
  for (const name of ['check','windows_installer_guard']) {
    const selected=jobs.jobs.filter(job=>job.name===name);
    assert(selected.length===1 && selected[0].status==='completed' && selected[0].conclusion==='success', 'required-ci-job-not-successful:'+name);
  }
  const observe = async () => {
    const [{data:ref},{data:statuses},{data:runs},releases] = await Promise.all([
      github.rest.git.getRef({...repo,ref:'heads/main'}),
      github.rest.repos.listCommitStatusesForRef({...repo,ref:source,per_page:100}),
      github.rest.actions.listWorkflowRuns({...repo,workflow_id:WORKFLOW,head_sha:source,branch:'main',event:'workflow_dispatch',per_page:100}),
      // Include promotion releases: their producing workflow may use an ops ref.
      // Pagination prevents older already-published sources from being rebuilt.
      github.paginate(github.rest.repos.listReleases,{...repo,per_page:100}),
    ]);
    return decideDispatch({source,main:ref.object.sha,statuses,runs:runs.workflow_runs,runCount:runs.total_count,releases});
  };
  const mark = async (state,description,url) => github.rest.repos.createCommitStatus({...repo,sha:source,context:CONTEXT,state,description,target_url:url});
  const finish = async decision => {
    if(decision.action==='reconcile') {
      await mark('success','One Nightly run recorded; publication still needs verification',decision.run.html_url);
      core.info(`Nightly run ${decision.run.id} for ${source}: ${decision.run.html_url}`);
      core.setOutput('nightly_run_id',String(decision.run.id));
      core.setOutput('source_sha',source);
      return true;
    }
    if(decision.action==='stop') throw Error(decision.reason);
    if(decision.action==='skip'){core.info(decision.reason);return true;}
    return false;
  };
  if(await finish(await observe())) return;
  // Persist BEFORE the one mutating request. A crash or ambiguous HTTP result
  // leaves a pending marker; a later job only reconciles and never blind retries.
  await mark('pending',`Exclusive Nightly dispatch intent from CI ${ci.id}`,ci.html_url);
  let dispatchUncertain=false;
  try {
    await github.rest.actions.createWorkflowDispatch({...repo,workflow_id:WORKFLOW,ref:'main',inputs:{publish:'true',source_sha:source}});
  } catch { dispatchUncertain=true; }
  // GitHub may create the run after the dispatch response. Bound reconciliation
  // and fail closed if no exact run is visible. No second dispatch is issued.
  for(let attempt=0;attempt<4;attempt++) {
    if(attempt) await new Promise(resolve=>setTimeout(resolve,5000));
    const decision=await observe();
    if(decision.action==='reconcile' || decision.reason==='source-already-published'){await finish(decision);return;}
  }
  throw Error(dispatchUncertain?'dispatch-ack-uncertain-reconcile-required':'dispatch-run-not-visible-reconcile-required');
}
module.exports=nightlyAfterCI;
module.exports.validateTrigger=validateTrigger;
module.exports.decideDispatch=decideDispatch;
