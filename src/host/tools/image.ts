import { isAbsolute } from 'node:path'
import type { Aspect, ImageRunner, MadePicture } from '../image.ts'
import { messageOf, stringOf } from '../json.ts'
import { failureResult, textResult, type Tool } from './registry.ts'

// Codex's image generation, for every provider. The picture is made in a hidden Codex turn
// (image.ts) and the caller gets its file path, not the pixels: a model that wants to see it
// reads the file, and an installed Craft app opens it with craft_open. Nothing of the run joins the
// calling chat's transcript but this call and its answer.

const MAX_REFERENCES = 4
const ASPECTS: Aspect[] = ['square', 'landscape', 'portrait']

const DESCRIPTION = `Make a new picture with Codex's image generation, from words alone or from reference pictures, and save it as a file. Use it only when the user asks for a picture to be made or a generative edit; to crop, zoom, resize or inspect a picture, use ordinary image tools instead, and never regenerate a picture to "improve" it. It takes about 20 seconds, spends the user's Codex image limit, and fails with a sentence saying when that limit resets. Answers with the saved file's path (and shows it on the library shelf as made by Codex); open it in an installed Craft app with craft_open (the app named in the call), or read the file to look at it.`

export function imageTools(runner: () => ImageRunner): Tool[] {
  return [{
    name: 'generate_image',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the picture should show: subject, style, light, and anything it must not contain.' },
        aspect: { type: 'string', enum: ASPECTS, description: 'The picture\'s shape. Leave out to let Codex choose.' },
        reference_images: {
          type: 'array', items: { type: 'string' }, maxItems: MAX_REFERENCES,
          description: `Absolute paths of pictures Codex should look at first, to edit them or follow their look; at most ${MAX_REFERENCES}.`
        }
      },
      required: ['prompt'], additionalProperties: false
    },
    run: async (args, context) => {
      const prompt = stringOf(args.prompt).trim()
      if (!prompt) return failureResult('IMAGE_PROMPT', 'Say what the picture should show, then call generate_image again.')
      const aspect = ASPECTS.find((entry) => entry === args.aspect)
      if (args.aspect !== undefined && !aspect) return failureResult('IMAGE_ASPECT', `aspect must be one of ${ASPECTS.join(', ')}.`)
      const references = Array.isArray(args.reference_images) ? args.reference_images.map(stringOf).filter(Boolean) : []
      if (references.length > MAX_REFERENCES) return failureResult('IMAGE_REFERENCES', `Give at most ${MAX_REFERENCES} reference pictures.`)
      const relative = references.find((path) => !isAbsolute(path))
      if (relative) return failureResult('IMAGE_REFERENCES', `${relative} is not an absolute path. Give each reference picture's full path.`)
      try {
        const made: MadePicture = await runner().generate({ prompt, ...(aspect ? { aspect } : {}), ...(references.length ? { references } : {}) }, context.chatId)
        return textResult(`Made ${made.width}×${made.height} picture, saved at ${made.path}\nCodex's reading of the brief: ${made.caption || '(none given)'}`)
      } catch (error) {
        return failureResult('IMAGE_GENERATION', messageOf(error), 'operation')
      }
    }
  }]
}
