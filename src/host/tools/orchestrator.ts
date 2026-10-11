import { PROVIDERS, type ProviderId } from '../../shared/types.ts'
import type { Orchestrator } from '../orchestrator.ts'
import { serializeOrchestrationState } from '../orchestrator.ts'
import { messageOf, recordOf, stringOf } from '../json.ts'
import type { CheckCount } from '../../shared/orchestrator.ts'
import type { CheckpointExtra } from '../orchestrator.ts'

function countOf(value: unknown): CheckCount | undefined {
  const entry = recordOf(value)
  const passed = entry.passed, total = entry.total
  if (typeof passed !== 'number' || typeof total !== 'number') return undefined
  if (!Number.isInteger(passed) || !Number.isInteger(total) || passed < 0 || passed > total) throw new Error('Give check counts as whole numbers, with passed no more than total.')
  return { passed, total }
}

function checksOf(value: unknown): CheckpointExtra['checks'] {
  if (value === undefined || value === null) return undefined
  const entry = recordOf(value)
  const typecheck = entry.typecheck === 'pass' || entry.typecheck === 'fail' ? entry.typecheck : undefined
  return { typecheck, tests: countOf(entry.tests), ui: countOf(entry.ui) }
}
import { failureResult, textResult, type Tool } from './registry.ts'

function verdictOf(value: unknown): CheckpointExtra['verdict'] {
  if (value === undefined || value === null) return undefined
  if (value === 'accept' || value === 'reject') return value
  throw new Error('Give verdict as accept or reject.')
}

export function orchestratorTools(runner: () => Orchestrator): Tool[] {
  return [{
    name: 'orchestrator',
    description: 'Run a continuous user-requested task from this owning chat. Start only when the user asks for continuous orchestration. Dispatch fresh worker chats (any number; excess queues FIFO per provider and when the machine or per-provider caps are full). At startup the host sets machineWorkerLimit from cores and available memory (one worker per core and per 0.75 GB available, at least one); status includes that limit. Per provider, Claude Codex and Cursor may run up to six at once; Antigravity one at a time (shared tool connection). Review their actual reports and checkpoint a terse progress.md (plan checklist, worker table, decisions—no pasted task results). Keep plan current at every checkpoint: upsert by id, mark dropped instead of deleting, tie new items to user-update index via from. Caps enforced with full-sentence refusals: summary 600, next 400, plan item text 140, decision 200 characters. Full reviews are written to task-NNNN-review.md beside the report. The host continues review turns when this turn ends; there is no fixed round limit. The leader uses the provider default. Dispatch can choose a worker model: Cursor usually uses Composer 2.5 and rarely changes models, though changes are allowed; Claude uses Haiku 5.5 for fast, reliable, easy tasks and stronger models when warranted; choose Codex models as you see fit. Available IDs come from models.list; the models action returns these live lists with isDefault marked. Never guess IDs. Name the model picked (or provider default) and why in each dispatch assignment. If model discovery fails, dispatch reports the failure and falls back to the provider default. Give each dispatch a title (at most 60 characters) and the planItem it serves. The user edits the plan from the progress view: their items are locked (carry them forward, keep their wording, ask before dropping or reopening), and each change must be acknowledged at the next checkpoint before any dispatch. Put only blockers in needs; next steps belong in the plan. Report check counts in checks. Code workers (Claude, Codex, Cursor) edit in their own git worktrees, made from the main folder when they start; pass worktree false only for read-only research. Antigravity always works in the main folder. Reviewing a worktree task, set verdict accept to merge its work into the main folder (the host merges after the checkpoint saves, one task at a time, after typecheck and unit tests pass on the merged result) or reject to discard it. A refused merge comes back in the next review with its files and reason; dispatch a fix-up with fixes set to that task id. Use reply to steer a running worker or reopen a finished one with corrections instead of waiting on its open questions. User notes in the progress file and chat messages steer future work. Stop cancels queued tasks; drain finishes only already-running workers. Workers cannot control other runs. Status and other run actions return compact worker rows (id, title, provider, model, status, planItem, report path, timing, short result, reviewed)—not full assignments. When more than 20 workers need review, the newest 20 are listed with a count and ids for the rest. Use detail with taskId for one worker\'s full task object including assignment. Return progress updates to the user and do not confuse completed turns or report existence with verified work.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'status', 'detail', 'models', 'dispatch', 'checkpoint', 'wait', 'resume', 'stop', 'reply'] },
        text: { type: 'string', description: 'Reply: message to send to the worker chat.' },
        task: { type: 'string', description: 'Start: the user task. Dispatch: one focused follow-up assignment.' },
        provider: { type: 'string', enum: PROVIDERS.map(provider => provider.id), description: 'Dispatch: worker provider. Models: optional provider filter.' },
        model: { type: ['string', 'null'], description: 'Dispatch: optional live model ID; omit or use null for the provider default.' },
        title: { type: 'string', description: 'Dispatch: a short name for the work, at most 60 characters.' },
        planItem: { type: 'string', description: 'Dispatch: the id of the plan step this worker serves.' },
        worktree: { type: 'boolean', description: 'Dispatch: give the worker its own git worktree. Default true for Claude, Codex and Cursor; pass false for read-only research. Antigravity never gets one.' },
        fixes: { type: 'string', description: 'Dispatch: the id of a task whose merge was refused; the fix-up starts from the main folder as it is now and is told where the refused change is.' },
        verdict: { type: 'string', enum: ['accept', 'reject'], description: 'Checkpoint, with taskId and review: accept merges a worktree task into the main folder, reject discards its worktree. Ignored for a task without a worktree.' },
        summary: { type: 'string', description: 'Checkpoint: terse progress (at most 600 characters).' },
        next: { type: 'string', description: 'Checkpoint: next action (at most 400 characters).' },
        taskId: { type: 'string', description: 'Checkpoint, reply, or detail: worker task id (e.g. 0001).' },
        review: { type: 'string', description: 'Checkpoint: full evidence review for taskId; saved beside the report.' },
        plan: {
          type: 'array',
          description: 'Checkpoint: plan items to upsert by id (text at most 140 characters; never delete—mark status dropped).',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              text: { type: 'string' },
              status: { type: 'string', enum: ['planned', 'active', 'done', 'dropped'] },
              tasks: { type: 'array', items: { type: 'string' } },
              from: { type: ['number', 'null'] }
            },
            required: ['id', 'text']
          }
        },
        decisions: { type: 'array', items: { type: 'string' }, description: 'Checkpoint: decisions to append (each at most 200 characters).' },
        acknowledge: {
          type: 'array',
          description: 'Checkpoint: one entry per pending user plan change (its id, such as c3), with a short sentence on what you will do. Required for every pending change.',
          items: { type: 'object', properties: { change: { type: 'string' }, text: { type: 'string' } }, required: ['change', 'text'] }
        },
        needs: {
          type: 'array',
          description: 'Checkpoint: every open question work cannot continue without (access, a permission, a missing input); one left out is resolved. Up to four short answers, the one you would pick first.',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, text: { type: 'string' }, from: { type: 'string', description: 'Who is blocked, such as "Worker 0024 cannot start".' }, options: { type: 'array', items: { type: 'string' } } },
            required: ['id', 'text']
          }
        },
        checks: {
          type: 'object',
          description: 'Checkpoint: the latest check results you ran; fields left out keep their last value.',
          properties: {
            typecheck: { type: 'string', enum: ['pass', 'fail'] },
            tests: { type: 'object', properties: { passed: { type: 'number' }, total: { type: 'number' } }, required: ['passed', 'total'] },
            ui: { type: 'object', properties: { passed: { type: 'number' }, total: { type: 'number' } }, required: ['passed', 'total'] }
          }
        },
        seconds: { type: 'number', description: 'Wait up to 25 seconds for a progress change; default 20.' },
        drain: { type: 'boolean', description: 'Stop: both modes cancel queued tasks. True lets running workers finish and writes a final review; false requests their cancellation. Default true.' }
      },
      required: ['action'], additionalProperties: false
    },
    run: async (args, context) => {
      try {
        if (!context.chatId) throw new Error('The calling chat could not be identified. Use a provider with a chat-bound tool connection.')
        const host = runner()
        if (host.stateError) throw new Error(host.stateError)
        const chat = context.chatId
        let result
        switch (args.action) {
          case 'start': result = host.start(chat, context.provider, stringOf(args.task)); break
          case 'status': result = host.get(chat); break
          case 'detail': {
            const run = host.get(chat)
            if (!run) return textResult('This chat does not own an orchestration.')
            const taskId = stringOf(args.taskId)
            if (!taskId) throw new Error('Give the worker task id to load its full record.')
            const task = run.tasks.find(entry => entry.id === taskId)
            if (!task) throw new Error(`There is no worker "${taskId}" in this orchestration.`)
            return textResult(JSON.stringify(task))
          }
          case 'models': {
            const provider = PROVIDERS.find(entry => entry.id === args.provider)?.id
            if (args.provider !== undefined && !provider) throw new Error('Choose an available provider for the model list.')
            return textResult(JSON.stringify(await host.models(chat, provider)))
          }
          case 'dispatch': {
            const provider = PROVIDERS.find(entry => entry.id === args.provider)?.id
            if (!provider) throw new Error('Choose a worker provider.')
            if (args.model !== undefined && args.model !== null && typeof args.model !== 'string') throw new Error('Choose a model ID string or null for the provider default.')
            result = await host.dispatch(chat, provider as ProviderId, stringOf(args.task), typeof args.model === 'string' ? args.model : null, {
              title: stringOf(args.title) || undefined,
              planItem: stringOf(args.planItem) || undefined,
              worktree: typeof args.worktree === 'boolean' ? args.worktree : undefined,
              fixes: stringOf(args.fixes) || undefined
            }); break
          }
          case 'checkpoint': {
            const plan = Array.isArray(args.plan) ? args.plan as Array<Record<string, unknown>> : undefined
            const decisions = Array.isArray(args.decisions) ? args.decisions.map(entry => stringOf(entry)) : undefined
            result = host.checkpoint(
              chat,
              stringOf(args.summary),
              stringOf(args.next),
              stringOf(args.taskId) || undefined,
              stringOf(args.review) || undefined,
              plan?.map(entry => ({
                id: stringOf(entry.id),
                text: stringOf(entry.text),
                status: typeof entry.status === 'string' ? entry.status as 'planned' | 'active' | 'done' | 'dropped' : undefined,
                tasks: Array.isArray(entry.tasks) ? entry.tasks.map(task => stringOf(task)) : undefined,
                from: entry.from === null ? null : typeof entry.from === 'number' ? entry.from : undefined
              })),
              decisions,
              {
                verdict: verdictOf(args.verdict),
                acknowledge: Array.isArray(args.acknowledge) ? args.acknowledge.map(entry => { const each = recordOf(entry); return { change: stringOf(each.change), text: stringOf(each.text) } }) : undefined,
                needs: Array.isArray(args.needs) ? args.needs.map(entry => {
                  const each = recordOf(entry)
                  return { id: stringOf(each.id), text: stringOf(each.text), from: stringOf(each.from) || undefined, options: Array.isArray(each.options) ? each.options.map(option => stringOf(option)) : undefined }
                }) : undefined,
                checks: checksOf(args.checks)
              }
            )
            break
          }
          case 'wait': result = await host.wait(chat, typeof args.seconds === 'number' && Number.isFinite(args.seconds) ? args.seconds : 20); break
          case 'resume': result = host.resume(chat); break
          case 'stop': result = host.stop(chat, args.drain !== false); break
          case 'reply': result = await host.reply(chat, stringOf(args.taskId), stringOf(args.text)); break
          default: throw new Error('Choose start, status, detail, models, dispatch, checkpoint, wait, resume, stop, or reply.')
        }
        if (!result) return textResult('This chat does not own an orchestration.')
        return textResult(JSON.stringify(serializeOrchestrationState(result, { machineWorkerLimit: host.machineWorkerLimit })))
      } catch (error) { return failureResult('ORCHESTRATOR', messageOf(error), 'operation') }
    }
  }]
}
