# Desktop Onboarding + Installer Flow Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Turn the desktop branch into an installer-ready app with a sane first-launch onboarding flow that configures AI, screenshot behavior, and at least one character before landing in the tracker.

**Architecture:** Keep the existing Electron + SQLite structure, but split startup into two explicit phases: `initializeApp()` for normal renderer boot and `runOnboarding()` for first-launch gating. Persist onboarding choices in SQLite-backed settings so the installed app behaves the same after reload/restart and doesn’t depend on renderer localStorage for setup-critical behavior.

**Tech Stack:** Electron 33, electron-builder/NSIS, SQLite via better-sqlite3, renderer HTML/CSS/JS in `desktop/dist/index.html`, main/preload IPC in `desktop/main.js` and `desktop/preload.js`.

---

## Audit findings

1. **First-launch setup currently dead-ends the renderer boot path.**
   - `DOMContentLoaded` calls `checkSetup()` and returns early if setup is incomplete.
   - After `setupComplete()` / `setupSaveCloud()` / `setupInstallLocal()` / first-launch skip, the wizard closes but the app is never initialized in the same renderer session.
   - Result: setup may complete, but the app does not transition cleanly into the tracker without a reload/restart.

2. **The setup wizard only covers AI config right now.**
   - It does not collect screenshot behavior (`Quick Add`, `Auto-create`).
   - It does not require or guide adding the first character.
   - This falls short of the intended installer/first-run experience.

3. **Screenshot behavior is still persisted in `localStorage`, not SQLite.**
   - That’s fine for the browser version, but not ideal for the desktop product.
   - Installed app behavior should live with the rest of desktop settings.

4. **Settings UI and first-launch wizard are not sharing one clear source of truth.**
   - AI config is SQLite-backed.
   - Screenshot settings are localStorage-backed.
   - Characters are settings-backed but only editable in the Settings panel, not first-launch wizard.

5. **Packaging exists but the first-launch experience is not yet installer-ready.**
   - `electron-builder` config is already present in `desktop/package.json`.
   - The app still needs onboarding completion, startup continuity, and fresh-install verification.

---

## Implementation order

### Task 1: Extract renderer startup into a reusable initializer

**Objective:** Make the app able to continue normally after onboarding completes, without requiring a manual reload.

**Files:**
- Modify: `desktop/dist/index.html` (`DOMContentLoaded`, startup helpers, setup completion paths)

**Steps:**
1. Create an `initializeApp()` async function that contains the current post-setup boot sequence:
   - `loadAll()`
   - `migrateData()`
   - `renderCharList()`
   - `updateFilterCharDropdown()`
   - `renderVariantList()`
   - `updateFilterVariantDropdown()`
   - `renderView()`
   - `renderMaterials()`
   - `initPersistenceListeners()`
2. Replace the inline `DOMContentLoaded` boot logic with:
   - `await checkSetup()`
   - if setup complete → `await initializeApp()`
   - if not complete → open wizard and wait
3. After successful first-launch setup completion (`setupInstallLocal`, `setupSaveCloud`, first-launch skip), call `await initializeApp()` after closing the wizard.
4. Guard against double init with a boolean like `let appInitialized = false;`.

**Verification:**
- Fresh state with incomplete setup opens wizard.
- Completing wizard lands directly in tracker without app restart.
- Manual `Run Setup Wizard` from Settings still closes cleanly without reinitializing the app twice.

---

### Task 2: Move screenshot behavior settings to SQLite-backed desktop settings

**Objective:** Make desktop onboarding/settings persistence consistent and installer-friendly.

**Files:**
- Modify: `desktop/dist/index.html`
- Modify if needed: `desktop/main.js`
- Modify if needed: `desktop/preload.js`

**Steps:**
1. Add settings keys for screenshot behavior in desktop storage:
   - `quick_add`
   - `auto_create`
2. Replace current localStorage reads/writes in:
   - `loadQuickAddSetting()`
   - `saveQuickAddSetting()`
   - `loadAutoCreateSetting()`
   - `saveAutoCreateSetting()`
   - `getQuickAddEnabled()`
   - `getAutoCreateEnabled()`
3. Keep a compatibility fallback for old localStorage values during migration, but write back to SQLite after first load.
4. Make the Settings panel and onboarding wizard read/write the same source.

**Verification:**
- Toggle settings, reload app, values persist.
- Fresh install defaults remain off unless chosen in onboarding.

---

### Task 3: Add onboarding step for screenshot behavior

**Objective:** Capture screenshot workflow preferences during first launch instead of dumping that on the user later.

**Files:**
- Modify: `desktop/dist/index.html`

**Steps:**
1. Add a wizard step after AI choice/config:
   - `Quick Add`
   - `Auto-create missing deviations/variants/traits`
2. Provide short plain-English descriptions.
3. Save these values together with the rest of onboarding state.
4. If OCR is skipped entirely, either skip this step or prefill both toggles off.

**Verification:**
- First-launch path saves toggles.
- Settings panel reflects the chosen values afterward.

---

### Task 4: Add onboarding step for first character

**Objective:** Ensure the app is usable immediately after first launch.

**Files:**
- Modify: `desktop/dist/index.html`

**Steps:**
1. Add a final wizard step requiring at least one character name before Finish.
2. Reuse the same validation rules as Settings:
   - trim
   - max 10 chars
   - dedupe
   - max 20 total if needed
3. Save the first character through the existing settings path.
4. If the user skipped OCR setup, they should still end up here before finishing first-run onboarding.

**Verification:**
- Fresh install cannot finish first-run onboarding with zero characters.
- Added character appears immediately in tracker dropdowns after onboarding completes.

---

### Task 5: Unify first-launch skip/manual cancel behavior

**Objective:** Preserve the good cancel behavior from Settings while keeping first-launch gating strict.

**Files:**
- Modify: `desktop/dist/index.html`

**Steps:**
1. Keep manual-open cancel as non-destructive.
2. On first launch:
   - allow OCR skip if desired
   - still continue through screenshot behavior defaults + first character step
   - do not mark onboarding fully complete until minimum required setup is done
3. Update button labels based on context:
   - manual open → `Cancel`
   - first launch → `Skip OCR for now` or equivalent

**Verification:**
- Manual open never nukes settings.
- First launch still reaches a usable configured state.

---

### Task 6: Package/fresh-install verification checklist

**Objective:** Prove the desktop app behaves correctly as an installed product.

**Files:**
- Modify: `desktop/package.json` only if packaging tweaks are needed
- Create: `docs/plans/desktop-packaging-checklist.md` (optional)

**Steps:**
1. Build NSIS installer with `npm run dist` from `desktop/`.
2. Test on a fresh user-data state / clean VM.
3. Verify:
   - installer launches app
   - first-launch wizard appears
   - OCR setup path works
   - OCR skip path works
   - screenshot settings persist
   - first character persists
   - app reload/restart preserves data
   - Settings → Run Setup Wizard behaves as edit mode, not destructive reset
4. Fix any installer-only path or asset issues.

---

## Immediate implementation target

Start with **Task 1** first.

Reason: without a reusable `initializeApp()` path, the rest of the onboarding work is built on a shaky base. The app needs to be able to finish setup and transition directly into the tracker in the same session.
