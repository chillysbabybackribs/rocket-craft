# Craft Studio: our own apps inside Rocket

Written 2026-10-10. This replaces the direction of `craft-studio-plan.md` (which ran ArtCraft's
apps unchanged); its measurements, licence notes and per-app details still hold and are reused.

## The idea in one paragraph

Rocket's chat on the left. Along the bottom of the right side, a dock with 12 apps, then Browser and
Library. Click an app and the right side becomes that app. Each app is our own copy of ArtCraft's
open-source code, changed so it fits Rocket properly. Models drive whichever app they are working
in, in the way that works best for that app, while you watch and can take over at any moment.
Several models can work at once, each in a different app.

Mockup to start from: [`mockups/craft-studio.html`](mockups/craft-studio.html) (its rail under the
right side is the dock).

## Decided

| Question | Answer (2026-10-10) |
|---|---|
| Who is it for? | Just you for now, a public release possible later. |
| Several models at once? | Yes, each in a different app. Built after one model works well. |
| Where does it live? | A fresh folder, `~/Desktop/craft-studio`. rocketv1 and rocket-orchestrator stay as they are. |
| Whose code are the apps? | Ours: copies of ArtCraft's code that we change and build ourselves. |

## The 12 apps

| Dock name | Our copy of | Like |
|---|---|---|
| Photo | PhotoCraft | Photoshop |
| Vector | VectorCraft | Illustrator |
| Film | FilmCraft | Premiere Pro |
| Light | LightCraft | Lightroom |
| PDF | PdfCraft | Acrobat |
| Effects | EffectCraft | After Effects |
| Design | DesignCraft | InDesign |
| Sound | SoundCraft | Pro Tools |
| Deck | DeckCraft | PowerPoint |
| CAD | CADCraft | AutoCAD |
| Words | WordCraft | Word |
| Grid | GridCraft | Excel |

## How it works

### The dock and the right side

- **Nothing is installed at first.** The right side opens on an app shelf: all 12 apps as cards,
  each with its name, what it is like (Photoshop, Excel…), its size, and an Install button.
- Installing an app adds its icon to the dock. Only installed apps are on the dock, plus Browser,
  Library and a Shelf button that brings the shelf back (to install more, update or remove one).
- Install means fetching a ready-made build of our copy (for you now: built on this machine, a few
  minutes per app; for a release: builds we publish). Removing an app deletes it and keeps your files.
- A model may suggest an app that is not installed ("Deck would do this; install it?"), but never
  installs one without asking.
- One click on a dock icon shows that app. Only one thing is on the right at a time: an app, the browser or the library.
- An app starts the first time it is clicked. Up to four stay running in the background so switching
  back is instant; beyond that, the one used longest ago closes, unless it has unsaved work.
- Each dock icon shows: running (dot), unsaved work, and which model is working in it right now.

### Our copies of the code

- Each app lives in `craft-studio/apps/<app>`, started from ArtCraft's code at a recorded version.
- Our changes are kept small and labelled, so ArtCraft's daily fixes can still be pulled in when
  you want them. Where an app needs a deep change, we take it fully into our hands, one app at a
  time.
- Changes every app gets:
  - a way for Rocket to drive it from inside the panel (PhotoCraft already has one, in `~/src/photocraft`);
  - the same command format in all 12 apps, so models learn one way of working;
  - "do you have unsaved work?" and "what changed?" answers after each command;
  - opening and saving files anywhere Rocket allows, including generated images and downloads;
  - no window frame of its own, Rocket's look around it.
- The PhotoCraft changes made for rocketv1 exist only as local edits in `~/src/photocraft`. They are
  saved somewhere lasting before anything else starts.

### How the app sits in the right side

Two ways exist. Phase 0 tries both on PhotoCraft and keeps the better one:

| | App as a web page in the panel | App's own window placed in the panel |
|---|---|---|
| Already working | Yes, PhotoCraft in rocketv1 today | No, untested |
| Speed | Slower on big filters and video | Full speed |
| Memory | Higher (a browser page per app) | Lower |
| Works on | Any Linux desktop | X11 only (this machine is X11) |
| Menus and popups over it | Same rules as the browser | Needs care |

FilmCraft has no web version upstream, so heavy apps (Film, Effects, Sound, Light) may end up as
windows even if the light ones are web pages. That mix is allowed.

### How models drive the apps

- One small, fixed set of tools works for every app, with the app named in each call: run a command,
  run several, look up commands, inspect, open, save, screenshot, and list/open/switch apps. This is
  what rocketv1 does for PhotoCraft today, so models see the same tools no matter which app is shown,
  and adding an app adds no tools.
- Ahead of each message a model is told which apps are open, what document each has, and who is
  working in which app.
- Images made with `generate_image`, files from the browser and the library all open in any app.

### Several models at once

- The orchestrator (already in Rocket) hands each worker its app and its task, for example "Deck:
  build the pitch from the brief" and "Film: cut the 30-second promo".
- One model works in one app at a time. A second model asking for the same app waits, or works on a
  copy of the file.
- You see who is where on the dock, and can take over any app; the model pauses until you hand back.
- Shared pieces (a logo, a chart's numbers) pass between apps as files in the project folder at
  first. A live link between apps comes later, once the basics work.

## Names and release

- Just for you now, so nothing has to be renamed yet.
- Done from day one anyway, because it is cheap: the ArtCraft name, wordmark and logo appear nowhere
  in our apps or in Craft Studio, and an About page lists every app's licence and notice.
- Before any public release: our own names and icons for the 12 apps ("Craft Studio" is a working
  name), and a final check of each app's brand notice.

## Phases

0. **Test (a few days).** Save the existing PhotoCraft changes. Show PhotoCraft both ways (web page
   and window) inside a bare Rocket copy; compare speed, memory, typing and copy/paste, menus, and
   whether models can drive it while it is hidden. Short report with pictures; pick the way.
1. **The new folder.** `~/Desktop/craft-studio`, a copy of Rocket with the parts this product does
   not use taken out (which copy is the better base, rocketv1 or rocket-orchestrator, is checked
   here). Typecheck, tests and the UI check green.
2. **Shelf, dock and one app.** The app shelf with install and remove, the dock of installed apps,
   PhotoCraft in the right side, start/stop/switch, unsaved-work handling. Mockup agreed before
   building.
3. **Models drive it.** The fixed tool set and the "what is open" note; a live check per provider
   (asked first, since it spends subscription usage).
4. **The other apps, in this order.** Grid and Deck (simple documents, and a chart from a sheet
   proves apps can share), Words, PDF, Vector, Design, Light, Film, Effects, Sound, CAD.
5. **Several models at once.** Workers per app, who-is-where on the dock, waiting and taking over.
6. **Comfort.** Pulling in ArtCraft's updates on request, crash restart, memory budget tuned on real
   documents.

## Limits of this machine

13 GB of memory, about 9 GB free with Rocket running. An empty app takes about 220–240 MB; real
documents take far more. Four apps running at once is the starting budget, tuned in phase 6. Each
app takes about 6 minutes to build as a desktop app and about 15 minutes as a web page (measured on
PhotoCraft); builds run only when an app's code changes.

## Risks

- ArtCraft's apps are early and change daily; we pull their updates only when we choose.
- Building and keeping 12 apps is real work; we take them one at a time and keep our changes small.
- If neither way of showing an app works well for the heavy apps, those wait while the others ship.
