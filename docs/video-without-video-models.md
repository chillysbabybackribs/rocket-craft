# Video without a video model

Research for Craft Studio, 2026-10-11. Question: ArtCraft sells video from Seedance, Kling and
Veo. Without paying for any API, what part of that can we build into the app as tools that the
subscription models (Claude, Codex, Cursor, Antigravity) drive themselves?

Short answer: everything around the motion can be built from free parts, and the motion itself can
be approximated in ways that suit some kinds of video and not others. Photoreal acting (a person
walking, cloth, water, a face performing) needs a trained video model. No tool replaces that. This
machine's GPU (GTX 1050, 3 GB) cannot run one. A 24 GB card could.

## What a video model actually does

| Capability | What it means | Can we build it? |
|---|---|---|
| Look and identity | The clip matches reference images: same character, style, set | **Yes.** Our two free image engines take references |
| Start and end frames | You fix the first and last frame, the model fills the middle | **Partly.** We can make both frames; filling a big gap needs a model |
| Camera motion | Pan, dolly, orbit, push-in, with parallax | **Yes**, as 2.5D from a depth map, or real 3D in EffectCraft |
| Object and character motion | Things move believably: physics, acting, cloth, fluids | **Only approximations** (see below) |
| Temporal coherence | No flicker frame to frame | **Yes** for anything animated in a compositor; **no** for frame-by-frame generation |
| Sound | Dialogue, effects, music in sync | **Dialogue yes** (local TTS); **lip sync** for stylised mouths; music partly |
| Extend | Continue a clip from its last frame | Only by planning the next shot from that frame |

## What we already have, free

- **Two image engines on subscriptions we pay for anyway.**
  - Codex's built-in `gpt-image-2` is already lent to every provider by `generate_image`.
  - Antigravity CLI 1.3.3 has its own `generate_image` tool: 11 pictures on this machine, made by
    it, sit in `~/.gemini/antigravity-cli/brain/`.
  - Rocket's adapter does not surface Antigravity's pictures yet. Agent research reports the
    Antigravity models page names the image model as Nano Banana 2, not user-selectable; that page
    was read by a subagent, not re-checked here.
- **EffectCraft**, the After Effects equivalent, is already one of the 12 apps.
  - It has keyframes (bezier, hold, eased) with a graph editor, and 3D layers with cameras, depth
    of field and lights.
  - It has 259 effects, including particles and simulation, and JavaScript expressions (`wiggle`,
    loops).
  - It exports H.264, ProRes with alpha and PNG/EXR sequences.
  - It has a headless CLI "for scripts and agents" and, per our plan doc, a `window.effectcraft`
    agent API.
- **FilmCraft**, the Premiere equivalent, has a real timeline, about 55 effects and 30
  transitions, keyframes, colour grading and an audio mixer. Its codecs are its own (no FFmpeg).
- **The models can look.** Every provider reads images, so a model can review its own render as
  a contact sheet of frames and fix it. This review loop is what turns cheap parts into a usable
  result.

## Free local parts that run on this machine

| Part | What it gives | Licence | Runs on |
|---|---|---|---|
| Depth Anything V2 **Small** (24.8M params) | Depth map from one image → 2.5D parallax camera moves, depth-of-field, fog | Apache-2.0 (Base/Large are CC-BY-NC, avoid) | CPU |
| BiRefNet | Cut a subject out of its background → layers, puppets, props | MIT | CPU via ONNX (speed unverified) |
| RIFE (`rife-ncnn-vulkan`) | In-between frames for two close frames; smooths 12 fps to 24/48 fps | MIT (portable binary, no CUDA or PyTorch) | Vulkan GPU or CPU |
| Kokoro-82M | Speech from text, 54 voices; its pipeline also returns the phonemes, which can drive mouth shapes | Apache-2.0 | CPU |
| Real-ESRGAN (ncnn-vulkan) | Upscale frames | BSD-3 | Vulkan |
| Blender (headless, `bpy`) | Real 3D: rigs, posing, camera blocking, renders | GPL (we only run it) | this GPU, Eevee renderer (tested, see below) |

Licence traps found on the way: RMBG-2.0 (rembg's default model) and Meta's MusicGen weights are
non-commercial, and Hunyuan3D's licence excludes the EU, UK and South Korea.

## How the models would make motion

Each shot gets a technique picked to suit it. These are the ones a model can drive end to end:

1. **2.5D camera moves.** One still → depth map → the image split into depth layers (cut-outs,
   with the hole behind each filled by an image-model edit) → a camera move in EffectCraft's 3D
   space. This is the "Ken Burns with parallax" look of documentaries, and it is coherent by
   construction. Best for establishing shots, landscapes and products.
2. **Cut-out puppets.** A character is generated once as separate parts (head, torso, arms) from
   a character sheet, cut out, parented in EffectCraft, then keyframed with expressions. This
   is the South Park / explainer style. Combined with Kokoro's phonemes swapping between six to
   eight generated mouth shapes, it gives lip-synced dialogue.
3. **Limited animation (key poses).** The image engine draws the key poses of a move with the
   character sheet as reference, and the poses are held "on twos" (12 fps), as in anime and
   stop motion. RIFE smooths only where poses are close. The cost: every pose spends Codex or
   Antigravity image quota, and identity drifts a little between poses. It suits stylised work,
   not realism.
4. **Effects motion.** Rain, snow, fire, smoke, light leaks, glitches and particles come from
   EffectCraft's simulation effects, laid over stills or puppets.
5. **Motion graphics and type.** Titles, kinetic type, charts, UI and explainer animation, written
   as keyframes or expressions. Models are already good at this.
6. **Real 3D.** Blocking, posing and a camera path in Blender (or EffectCraft's 3D), rendered as
   a draft. Then either use the render as is (stylised) or restyle each key frame with the image
   engine using the render as reference. Restyling every frame flickers, so restyle the key frames
   and hold them.

**Blender tested here, 2026-10-11.** Blender 5.2.2 LTS (portable tarball, checksum verified) ran
headless (`blender -b --factory-startup -P shot.py`). One script of about 90 lines built a scene:
a floor, a pedestal, a smooth metallic hero object turning, 12 glowing orbs rising, key and rim
area lights, and a camera dollying in and arcing with f/1.8 depth of field. Eevee rendered 72
frames at 960×540 in 5 min 20 s on the GTX 1050. Steady frames took about 2 s each; the rest was
startup and shader compiling. Peak memory was 1 GB. ffmpeg encoded the MP4, and a 3×2 sheet of
sampled frames was enough to review the motion. The sheet showed three faults a model would fix
on its next pass: the metal looks dark with no environment to reflect, the pedestal is faceted,
and the orbs render white because bloom is off. The script and output are in `/tmp/blender-scripts`
and `/tmp/blender-out`, and will not survive a reboot.

What Blender adds for the models: real 3D cameras and lights, rigs and posing, physics (cloth,
fluids, rigid bodies, particles), Geometry Nodes for procedural scenes, and Grease Pencil for 2D
animation. Generated stills go in as textures, backdrops or cards. It brings no learned motion:
a walk cycle has to be keyframed or come from a rig and motion data. This is the most capable
of the six techniques.

What none of these do: a photoreal person walking down a street, hair and cloth moving, a face
acting. That is the one thing the paid models sell that we cannot make.

## Tools to add to the tool server

Small, single-purpose tools, each returning file paths, in the style of `generate_image`:

| Tool | Does | Backed by |
|---|---|---|
| `generate_image` (exists) | Stills, character sheets, key poses, start/end frames, clean plates | Codex `gpt-image-2` |
| Antigravity pictures | Surface the CLI's own `generate_image` output as image items, a second free engine | adapter change |
| `depth_map` | Image → depth PNG | Depth Anything V2 Small |
| `cut_out` | Image → subject PNG with alpha (+ mask) | BiRefNet |
| `interpolate` | Two frames or a frame folder → in-betweens | rife-ncnn-vulkan |
| `speak` | Text + voice → WAV and phoneme timings | Kokoro |
| `shot` | A shot spec (layers, depth, camera path, keyframes, effects, duration) → an EffectCraft comp, rendered | EffectCraft CLI / control channel |
| `look` | A video → contact sheet and sampled frames, so the model can review motion | frame extraction |
| `cut` | Shots + audio → an edit in FilmCraft | FilmCraft control channel |

A video goal would then run as: brief → storyboard of stills → one technique per shot → render →
`look` → fix → edit and sound. Craft Studio's goal loop (`goals.ts` in Rocket) already has this
work-then-check shape.

## Routes we did not take, and why

- **Paid APIs** (BytePlus Seedance, Kling, Gemini Veo, fal, Replicate). Out of scope by choice.
  Agent research reported per-second prices from about $0.05 (Veo 3.1 Lite) to $0.57 (Seedance
  2.5 at 1080p), and that OpenAI shut down the Sora 2 API on 2026-09-24.
- **Driving the subscription web apps** (Gemini/Flow Veo, Sora, Midjourney, Grok) with the user's
  sign-in. ArtCraft does this: its source has cookie-authenticated clients for Midjourney, Sora,
  Grok and World Labs. The terms differ:
  - Midjourney forbids "automated tools to access, interact with, or generate Assets".
  - OpenAI's terms forbid "automatically or programmatically extract data or Output".
  - Google's terms bar automated access only "in violation of the machine-readable instructions
    on our web pages (for example, robots.txt files…)".

  So Google is the least risky, but what a Google AI plan includes for Veo is unverified here. A
  human-in-the-loop version (the model prepares the prompt and reference frames in the browser
  tab, the user presses Generate) is possible later if wanted.
- **Local video models.** Agent research: Wan 2.2's 5B model makes 720p on a 24 GB card;
  HunyuanVideo 1.5 needs at least 14 GB with offloading. Not possible on 3 GB. A 24 GB GPU is the
  one way to get true generative motion with no per-clip cost. If one is added later, a
  `generate_clip` tool slots in beside the others; the rest of the pipeline stays.

## Suggested first step

Build `depth_map`, `cut_out` and `shot` for technique 1 (2.5D camera moves), plus `look`. It needs
no image quota beyond one still per shot, it is coherent, and it shows whether the models can
drive EffectCraft well enough for the rest.

## Sources

Opened while writing this:
- EffectCraft: https://getartcraft.com/apps/effectcraft
- FilmCraft: https://getartcraft.com/apps/filmcraft
- Depth Anything V2 (sizes, licences): https://github.com/DepthAnything/Depth-Anything-V2
- rife-ncnn-vulkan: https://github.com/nihui/rife-ncnn-vulkan
- Kokoro-82M: https://huggingface.co/hexgrad/Kokoro-82M
- Google Terms of Service: https://policies.google.com/terms?hl=en-US
- OpenAI Terms of Use: https://openai.com/policies/row-terms-of-use/
- Midjourney Terms of Service: https://docs.midjourney.com/hc/en-us/articles/32083055291277-Terms-of-Service
- ArtCraft source (model catalogue, consumer clients): https://github.com/storytold/artcraft

Read by research agents, not re-opened here: BiRefNet (github.com/ZhengPeng7/BiRefNet), Real-ESRGAN
(github.com/xinntao/Real-ESRGAN), Wan 2.2 (github.com/Wan-Video/Wan2.2), HunyuanVideo 1.5
(github.com/Tencent-Hunyuan/HunyuanVideo-1.5), Antigravity models (antigravity.google/docs/models),
Gemini API pricing (ai.google.dev/gemini-api/docs/pricing), OpenAI video deprecation
(developers.openai.com/api/docs/deprecations).
