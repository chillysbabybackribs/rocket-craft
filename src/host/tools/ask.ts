import type { Item, QuestionOption } from '../../shared/types.ts'
import { oneLine, recordOf, stringOf } from '../json.ts'
import type { Hub } from '../hub.ts'
import { textResult, type Tool } from './registry.ts'

// A question for the user, asked without stopping. The tool posts a card in the chat and returns
// at once; the model carries on with whatever the answer does not change and ends its turn as
// usual, so no CLI is ever left holding a connection open for a human. If the user answers, by
// clicking an option or typing, it arrives as the chat's next message. The limits here are what
// keeps the tool from becoming a nag: one question per turn, two to four options, each with its
// consequence, and the model's own pick named, so an unanswered question costs nothing.

const MAX_OPTIONS = 4
const MIN_OPTIONS = 2
const QUESTION_LIMIT = 240
const LABEL_LIMIT = 48
const DETAIL_LIMIT = 180

const DESCRIPTION = `Ask the user one question whose answer would change what you build, when the folder, the conversation and a quick look cannot settle it: a trade-off only they can weigh, a choice between real alternatives, scope that is theirs to set. Give 2 to 4 options, each a short label and what picking it means in one sentence, and say which you would pick. The question is posted in the chat and you get no answer now: carry on with everything the answer does not change, do not build down the path you would pick if it may be thrown away, and say in your reply what is waiting on them. Their answer, if they give one, comes as the next message. Not for confirmation, for what the code or the folder shows, for preferences you can infer from the work so far, or for anything small enough to decide yourself. One question per turn.`

type Question = Extract<Item, { type: 'question' }>

function optionOf(value: unknown): QuestionOption | null {
  const record = recordOf(value)
  const label = oneLine(stringOf(record.label), LABEL_LIMIT)
  const detail = oneLine(stringOf(record.detail), DETAIL_LIMIT)
  return label ? { label, detail } : null
}

/** Check and tidy a call's arguments; a string is what is wrong with them, in words for the model. */
export function parseQuestion(args: Record<string, unknown>): { text: string; options: QuestionOption[]; recommended: number } | string {
  const text = oneLine(stringOf(args.question), QUESTION_LIMIT)
  if (!text) return 'Give the question in `question`, as one sentence the user can answer without reading code.'
  const raw = Array.isArray(args.options) ? args.options : []
  const options = raw.map(optionOf).filter((option): option is QuestionOption => option !== null)
  if (options.length < MIN_OPTIONS) {
    return `Give ${MIN_OPTIONS} to ${MAX_OPTIONS} options, each with a short \`label\` and its \`detail\`: what picking it means. If there are not two real choices, decide yourself and say so in your reply.`
  }
  if (options.length > MAX_OPTIONS) return `Give at most ${MAX_OPTIONS} options; fold the rest into the closest one or leave them out.`
  if (options.some((option) => !option.detail)) return 'Every option needs a `detail`: one sentence on what picking it means for the work.'
  const labels = new Set(options.map((option) => option.label.toLowerCase()))
  if (labels.size !== options.length) return 'Two options have the same label. Make each one a different choice.'
  const recommended = typeof args.recommended === 'number' ? Math.trunc(args.recommended) : NaN
  if (!(recommended >= 0 && recommended < options.length)) {
    return `Give \`recommended\`: the index (0 to ${options.length - 1}) of the option you would pick, so the user can take your word for it with one click, and so you know what to do if they never answer.`
  }
  return { text, options, recommended }
}

/** The answer as it goes to the model: the question quoted, then what the user said. */
export function answerMessage(question: Question, answer: string): string {
  return `> ${question.text}\n\n${answer}`
}

export function askTools(hub: () => Hub): Tool[] {
  return [
    {
      name: 'ask_user',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'One sentence the user can answer without reading code: the decision and why it is theirs.' },
          options: {
            type: 'array',
            description: '2 to 4 real alternatives.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'The choice in a few words.' },
                detail: { type: 'string', description: 'What picking it means for the work, in one sentence.' }
              },
              required: ['label', 'detail']
            }
          },
          recommended: { type: 'integer', description: 'Index of the option you would pick yourself.' }
        },
        required: ['question', 'options', 'recommended'],
        additionalProperties: false
      },
      run: (args, context) => {
        if (!context.chatId) return { ...textResult('Craft Studio could not tell which chat this call came from. Put the question in your reply instead.'), isError: true }
        if (hub().liveQuestion(context.chatId)) return { ...textResult('You have already asked the user something this turn. Put anything else in your reply and carry on.'), isError: true }
        const parsed = parseQuestion(args)
        if (typeof parsed === 'string') return { ...textResult(parsed), isError: true }
        const posted = hub().addItem(context.chatId, (turnId) => ({
          type: 'question',
          id: `${turnId}:question`,
          turnId,
          ...parsed,
          answer: null
        }))
        if (!posted) return { ...textResult('No turn is running in this chat, so there is nowhere to post the question. Put it in your reply instead.'), isError: true }
        return textResult(`Asked. The user sees "${parsed.options[parsed.recommended]!.label}" as your pick. Carry on with what the answer does not change and end your turn as usual; their answer, if any, comes as the next message.`)
      }
    }
  ]
}
