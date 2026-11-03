# RMT Animation Studio - suite spec

Own folder, own app id, own API port (:47680). A copy of Fight Studio Desktop 1.2.0 taken 2026-11-02; the original
(D:\Projects\FightStudioDesktop) and the Godot Effect Studio (BSP-Universe/addons/rmt_effects) are NOT touched.

## Goal
One app for poses, effects, camera and audio on one timeline. Easy layer on top, full control behind a Pro toggle.

## Modes (top bar)
- POSE    today's Fight Studio (keys, IK, Fill, Merge, Layers, Adjust, Feet).
- FX      full Effect Studio: library, live sliders, shaders/textures, overrides, save/revert (manifests of rmt_effects).
- COMPOSE pose + effects on one unit: scrub bar, cue lanes (spawn at socket on a frame), camera and audio tracks.
- REVIEW  strip/sheet views plus checks (feet planted, arm twist, wrap, reach).
- SETUP   guided pipeline for a new unit/move: import model -> rig v4 + fingers -> Collision Wrap bake -> feet check ->
          sockets -> move template -> attach effects (trail, hit spark, ground impact) -> all checks -> export to game.
          Each step shows pass/fail.

## Easy vs Pro
Easy: big buttons, presets, recipes ("punch + spark"). Pro: every knob, curves, agent API, scripting.

## Effect models
Authored in Blender (RMT Effect Forge); "send to studio" for live round trips.

## Build order
1. Mode shell + unified timeline with effect cue tracks.   DONE 2026-11-02 (modes bar + Alt+1..5, FX lane in the dope sheet,
   Setup panel with 9 live steps, Library panel: Models / Animations / Effects)
2. Port full FX mode (manifests, shaders, overrides).   DONE 2026-11-02 (FX Studio panel + `fx_studio` API: live-edit any block,
   layer timeline, shader / texture knobs read from the .gdshader, save a user override, revert to shipped)
3. SETUP mode pipeline.   DONE 2026-11-02 (src/setup.js: each of the 9 steps that is not done has a fix; FIX ALL runs them in order)
4. REVIEW/COMPOSE polish.   DONE 2026-11-02 (src/review.js, src/compose.js, src/moveinfo.js; `review` and `compose` APIs).
5. Installer.   DONE 2026-11-02 (`npm run dist` -> dist/RMTAnimationStudio-Setup-2.0.0.exe, 107 MiB, NSIS, unsigned; see Installer below).
   Camera / audio tracks are still to do.

## Rules carried over
Fight Studio for all animation; feet planted; knees/joint limits; collision wrap on every character; one escape roll.

## Status 2026-11-02
- Synced from FightStudioDesktop (rig v5 upgrade) and its shader fixes; own port :47680; selftest 300 checks (about 4 min:
  `npm run selftest`, result in out/desktop.log). Godot reference numbers for the parity checks: D:\Cache\rmt_studio_refs
  (regenerate with ref_fx.gd / ref_fill.gd there).
- Test run options: --mode=FX|SETUP|..., --lib=Models|Animations|Effects, --shot=path.png --shot-wait=ms, --api-port=47681.
- FX Studio (src/fxstudio.js, slice 2): `FxStudio` engine (app.fxs) keeps a working copy of one effect block and rebuilds the
  preview 80 ms after any edit; plays beside the fighter (origin or a socket), loop / speed / scrub, mute / solo per layer, add /
  duplicate / remove / reorder layers, per-layer start and cut by dragging the layer timeline. The panel builds its controls from the
  layer: TIMING, TRANSFORM, light, decal, shader uniforms (ranges and descriptions come from the .gdshader's own `hint_range` and
  `//` comments, reset button per value, texture pickers from the addon's textures), particles, trail, color ramp. Save writes a
  user override to the Godot user dir (`rmt_effects/<id>.json`, the same place the game reads); Revert moves it to the trash folder.
  API: `fx_studio {open, select, fold, set:{layer,path,value}, add_layer, remove_layer, time, play, at, revert, save, manifest}`,
  `set_mode`. Section folds are kept per kind (TIMING, TRANSFORM, SHADER ...) on the engine. Keyframed layer tracks are kept, not
  edited yet. Revert copies the override to the trash and then removes it (the Godot user dir and the trash are often on
  different drives, where a rename fails: the selftest caught this).
- Setup (src/setup.js, slice 3): `SetupEngine` (app.setup) reads the 9 steps from the real state; a step that is not done has a fix.
  rig = reload rig_v5.json and remap; wrap / soles = the game's own wrap_bake.gd / feet_bake.gd run headless in Godot (host `bake`,
  about 4 s a fighter; the wrap is rewritten for one fighter, the soles for all) and the fighter reloads; a wrap or soles file older
  than its model shows amber STALE ("bake it again", the rule: a current wrap after any model change); sockets = move sockets on
  bones the model lacks to the nearest bone it has, saved for this fighter only; move = copy the first pose to the last frame (or
  NEW MOVE, a named clip with both keys); effects (optional) = an `impact_spark` on the striking limb at the clip's hit mark (else
  where a limb is fastest), or `cloud_puff` at the feet on a landing; checks = turn forward knees straight, bring joints back
  inside their limits, close the loop seam, key a changed pose (one undo step; locked keys stay as they are; what is left is
  listed under the step); saved = save the clip. FIX ALL runs rig, wrap, soles, sockets, move, checks, saved in order (effects
  only on request), stops at the first failure, and its confirm lists every step, including the save. A fix that writes into the
  game project asks first; the API (`setup {fix, yes, name, save, effects, new_move}`) only returns the plan unless `yes: true`.
  First finding on the real data (2026-11-02): every fighter's model was rewritten Nov 2 13:48 and its wrap was baked Oct 30;
  re-baking Vix into a scratch folder gives a wrap that differs (tail up to 10.7 cm, torso 6.3 cm, rules and pairs changed), so the
  amber flag is real. On the user's go, Vix's wrap was baked through Setup itself (3.7 s, only data/wraps/vix.collide.json changed;
  the old file is in git HEAD 535faa0 and in D:\Cache\setup_bake_test\vix_current_copy.json). Vix's 55 clips under the Body Solve
  (tolerance 1 cm): 32 clean on the old wrap, 34 clean on the new one, so the re-bake did not cause the clashes left in 21 clips
  (mostly legR|torso 1.4-5 cm, a_vix_land tail3|FLOOR 15 cm). Then the other ten fighters' wraps were baked the same way
  (1.3-2.5 s each; old copies in D:\Cache\setup_bake_test\old_wraps). Their 541 clips under the Body Solve: 399 clean on the old
  wraps, 404 on the new (hype 30 -> 32, vic 30 -> 33, the other eight unchanged); 21 clips got better and 18 a little different
  (mostly *_land and a few vic / kat arm clips: e.g. a_vic_fthrow handL|handR 4.3 -> 15.3 cm, a_kat_bair legR|handR 4.1 -> 9.2 cm).
  137 of 541 clips still have a clash left, as before (kat 30 of 55, hype 21, vic 21, bigbill 21, carter 22).
- Review (src/review.js, slice 4): a verdict on the open move, READY / NEEDS WORK / BLOCKED, from cards that each read real state:
  joints (knees, limits, fingers), arms and wrists (twist), loop seam, feet (planted slide, tipped feet), Collision Wrap (the head
  line of the wrap check; the rows under it are detail), game data (wrap and soles baked from the current model, from SETUP's
  steps), effects against the hit (an impact burst more than 2 frames at 60 fps off the hit mark is "early / late by n f";
  swings and follows are not held to the beat; an attack with no effect or no hit mark is a note, not a warning), saved (a note).
  Below the cards: frame data from the hit / clear marks (startup = frames before the hit, active = hit..clear, recovery = after,
  in the clip's frames, game frames at 60 fps and ms), the four strikers' top speed (through the world, as the game shows it:
  a lunge carries the limbs) and reach (horizontal from the hips, and ahead of them), view buttons (angles, layouts, wrap / capsules /
  onion / trail / game feet), CONTACT SHEET (the render panel's 4-angle sheet), COPY REPORT, NEXT PROBLEM. It runs while the panel
  is on screen, a moment after the clip, the save, the cues or the mode change; edits show "RE-RUN". API
  `review {sheet?}` -> {verdict, counts, cards, frame_data, strikers, effects, text}; reads only.
- Compose (src/compose.js, slice 4): RECIPES put the right effects on the move from what it does: hit spark (impact_spark on the
  striker at the hit), swing trail (motion_trail follow from the wind-up to 2 f after), kick swoosh (a foot striker, 2 f before),
  heavy hit (spark x1.4 + shockwave + hit_scuff), landing dust (cloud_puff at each real touchdown: 15 cm in the air for a few frames,
  not a loop), footsteps (small puff under each foot contact, walks / runs / dashes). A recipe that does not fit says why (strike
  recipes need an attack or a hit mark); one that is already on the clip adds nothing. Pro layer: snap a cue to the hit, the clear, its
  limb's fastest frame, the nearest foot contact, the ends or the playhead; nudge; shift all cues (never past the ends); IMPACTS ON THE
  HIT; swap side (fist_R <-> fist_L); copy; remove; a beat sheet of the marks and cues with frames from the hit. Every change is one
  step of COMPOSE's own undo (cues are not in the clip's undo history); nothing reaches the game until the clip is saved. API
  `compose {recipe?, apply?, snap?, nudge?, shift_all?, align?, swap_side?, duplicate?, remove?, undo?, save?}` (a recipe without
  `apply: true` only returns its plan). The Godot-opening call that was also called `fx_studio` is now `fx_studio_godot` (the in-app
  FX Studio had shadowed it, and the doc list showed the wrong one).
- moveinfo.js measures the move once on the probe body (keyed pose, no Body Solve): striker paths, hips, lowest foot, foot contacts,
  touchdowns; kept until the clip changes (the `app.ctx` identity). SETUP's effect suggestion now uses it too.
- Selftest 2026-11-02 after slice 4: 338 checks, 0 failed (`npm run selftest`; `--only-wrap` stops after the Collision Wrap parity
  block, about a minute). Two things moved under the references and were put right: (1) the game's models were rewritten Nov 2 13:48
  with real Spine1 / clavicles / toes (rig_v5 in the GLB extras), so the game's Body Solve now bends Spine1 - src/core/wrap.js skipped
  every rig_v5 joint, and now skips only the joints this app inserts itself (rigV5Upgrade); al / kat / slum ult clips match the game's
  solve again (worst step 0.04 degrees); (2) the wraps were re-baked, so the wrap reference is made again by ref_wrap.gd into
  D:\Cache\rmt_studio_refs\ref_wrap.json (the original app's D:\Cache\fight_studio_dev\ref_wrap.json is left alone) and ref_fx.json
  was regenerated (the nair's right leg had been re-keyed; the old one is kept as ref_fx.before_2026-11-02_sole.json).
- Installer (2026-11-02): version 2.0.0; `npm run dist` (electron-builder 26.0.12, NSIS, x64, asar) writes
  dist/RMTAnimationStudio-Setup-2.0.0.exe (112,135,382 bytes) and dist/win-unpacked/. App id com.rmt.animationstudio, per-user
  install, the user picks the folder, desktop + Start menu shortcuts "RMT Animation Studio". Icon: tools/make_icon.py draws
  build/icon.png and build/icon.ico (RMT in orange on ink with a gold offset, Bahnschrift Bold). Packed: main.js, preload.js,
  src/, tests/, three + its examples/jsm only. The packaged app (win-unpacked) passed the whole selftest on a throw-away profile
  (`--user-data-dir=D:/Cache/rmt_pkg_profile`): 338 passed, 0 failed. The NSIS installer itself was not run (nothing installed on
  this machine); it is unsigned, so Windows SmartScreen will warn. electron-builder's winCodeSign archive cannot be extracted on
  Windows without the symlink privilege (two macOS dylib links fail), so it was unpacked by hand into
  %LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0 (the two dylib errors ignored); after that the build runs.
  Only the game's Godot path and its data are read from the machine, so the installed app needs the BSP Universe project and
  Godot where this machine has them (the Setup panel says what it finds).
- Installer pictures (2026-11-03): tools/make_installer_art.py draws build/installerSidebar.bmp + uninstallerSidebar.bmp (164x314: a
  frame of the Vix ultimate under a slash, the RMT wordmark and version below), build/installerHeader.bmp (150x57, icon + wordmark) and
  the logo (build/logo.png = docs/logo.png, the README banner); package.json nsis points at them. Rebuilt the same day with the default
  bone tier "advanced" (synced from Fight Studio Desktop; the first build had "simple"): 112,238,284 bytes, still unsigned. Seen by
  opening the installer (not installing): the header picture and the icon show; the sidebar belongs to the finish page and the
  uninstaller's welcome page, which were not opened. The installer notices an earlier per-user install and upgrades it.
- Not built: camera and audio tracks (the game has no clip format for either yet).
- Next: camera / audio when the game has somewhere to read them.
