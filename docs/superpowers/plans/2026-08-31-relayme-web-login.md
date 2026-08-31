# RelayMe Official Web Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure RelayMe official web-login path that activates RelayMe only after a real model-catalog validation, while preserving direct password login and existing user data.

**Architecture:** The renderer invokes a no-secret provider bridge command. The RelayMe provider service asks an injected desktop-owned web authenticator for a token, validates that token through the existing `/models` client, and atomically persists it only after validation. A focused Electron module owns the sandboxed official-origin login window and never exposes tokens or page storage to the renderer.

**Tech Stack:** TypeScript, React, Electron 43, Zod bridge contracts, Vitest, Playwright, npm workspaces, electron-builder.

**Spec:** `docs/superpowers/specs/2026-08-31-relayme-web-login-design.md`

## Global Constraints

- Only `https://www.ml.relayme.uk` may supply a RelayMe web-login token.
- RelayMe passwords, tokens, cookies, page storage, and raw provider responses must never cross into the renderer or logs.
- A login is successful only after the RelayMe model catalog is non-empty and has been converted into usable profiles.
- Failed or cancelled login must preserve the existing encrypted credential, profiles, and active provider.
- Do not automatically run paid image or video generation.
- Do not reset, clean, migrate, overwrite, commit, or discard existing user/worktree data.
- Preserve the existing direct image/video generation and task-polling boundary.

---

### Task 1: Web Login Bridge Contract

**Files:**
- Modify: `packages/desktop-core/src/provider-contracts.ts`
- Modify: `packages/desktop-core/src/provider-contracts.test.ts`
- Modify: `packages/desktop-core/src/provider-service-types.ts`
- Modify: `packages/desktop-core/src/provider-ipc-handlers.ts`
- Modify: `packages/desktop-core/src/provider-ipc-registration.ts`
- Modify: `packages/desktop-core/src/preload-api.ts`
- Modify: `packages/desktop-core/src/preload-api.test.ts`
- Modify: `packages/desktop-core/src/bridge-contract.test.ts`

**Interfaces:**
- Produces: `PROVIDER_BRIDGE_CHANNELS.loginRelayMeWeb` with channel `novus-desktop:provider:login-relayme-web`.
- Produces: `ProviderService.loginRelayMeWeb?(): Promise<void>`.
- Produces: `DesktopProviderBridgeApi.loginRelayMeWeb(): Promise<ProviderActiveState>`.
- Consumes: existing no-payload schema, provider success/error envelopes, and active-provider store.

- [ ] **Step 1: Write failing contract and preload tests**

Add assertions equivalent to:

```ts
expect(PROVIDER_BRIDGE_CHANNELS.loginRelayMeWeb)
  .toBe('novus-desktop:provider:login-relayme-web');
expect(parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.loginRelayMeWeb, undefined))
  .toBeUndefined();
await expect(provider.loginRelayMeWeb()).resolves.toEqual({ activeProvider: 'relayme' });
expect(invoke).toHaveBeenCalledWith(
  PROVIDER_BRIDGE_CHANNELS.loginRelayMeWeb,
  undefined,
);
```

Add an IPC-handler test proving `loginRelayMeWeb()` runs on the RelayMe service and sets the active provider only after it resolves.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run --config vitest.config.ts packages/desktop-core/src/provider-contracts.test.ts packages/desktop-core/src/preload-api.test.ts packages/desktop-core/src/bridge-contract.test.ts packages/desktop-core/src/provider-ipc-handlers.test.ts
```

Expected: failures report that `loginRelayMeWeb` is absent from the channel map, preload API, or handler.

- [ ] **Step 3: Implement the minimal bridge path**

Add the channel to both request/response schema maps using `noPayloadSchema` and `ProviderActiveStateSchema`. Add the optional service method, required handler method, IPC registration entry, and preload method. The handler must use this order:

```ts
await service.loginRelayMeWeb();
return parseProviderBridgeResponse(
  PROVIDER_BRIDGE_CHANNELS.loginRelayMeWeb,
  await requireActiveStore(options).setActiveProvider('relayme'),
);
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all selected tests pass and no protected payload appears in serialized calls.

- [ ] **Step 5: Review diff without committing**

Run `git diff -- packages/desktop-core/src/provider-contracts.ts packages/desktop-core/src/provider-service-types.ts packages/desktop-core/src/provider-ipc-handlers.ts packages/desktop-core/src/provider-ipc-registration.ts packages/desktop-core/src/preload-api.ts` and verify only the new no-secret bridge surface was added.

### Task 2: Provider Token Validation and Atomic Persistence

**Files:**
- Modify: `packages/provider-relayme/src/account-auth.ts`
- Modify: `packages/provider-relayme/src/account-auth.test.ts`
- Modify: `packages/desktop-core/src/relayme-provider-service.ts`
- Modify: `packages/desktop-core/src/relayme-provider-service.test.ts`

**Interfaces:**
- Produces: `RelayMeProviderServiceOptions.loginWebAccount?: () => Promise<string>`.
- Produces: `ProviderService.loginRelayMeWeb(): Promise<void>` when the callback exists.
- Produces: one shared private commit path used by password and web login after model validation.
- Consumes: `RelayMeClient.listModels()`, `credentialStore.configure({ token })`, `buildRelayMeModelProfiles(models)`, and the existing provider configuration store.

- [ ] **Step 1: Write failing provider tests**

Add tests proving:

```ts
const service = createRelayMeProviderService({
  ...options,
  loginWebAccount: async () => 'opaque-official-session-token',
});
await service.loginRelayMeWeb?.();
expect(fetch).toHaveBeenCalledWith(
  expect.stringMatching(/\/models$/u),
  expect.objectContaining({
    headers: expect.objectContaining({ authorization: 'Bearer opaque-official-session-token' }),
  }),
);
expect(await credentialStore.getToken()).toBe('opaque-official-session-token');
```

Add a failure test that seeds `old-token`, makes `/models` fail, calls web login, and asserts `getToken()` still returns `old-token`, the configuration file is unchanged, and no active-provider mutation occurs in this service layer.

Add a password-auth test showing a successful `data.token` may be an opaque non-empty official token rather than requiring exactly three JWT segments.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run --config vitest.config.ts packages/provider-relayme/src/account-auth.test.ts packages/desktop-core/src/relayme-provider-service.test.ts
```

Expected: the opaque-token auth test fails with `TOKEN_MISSING`, and the service has no `loginRelayMeWeb` method.

- [ ] **Step 3: Implement shared validated login commit**

Change token extraction to accept a trimmed, non-empty bounded token while still rejecting whitespace and never including token content in errors. Add a private helper with this behavior:

```ts
async function validateAndPersistLoginToken(token: string): Promise<void> {
  const models = await new RelayMeClient({
    baseUrl: configuration.baseUrl,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    tokenSupplier: async () => token,
  }).listModels();
  const profiles = buildRelayMeModelProfiles(models);
  if (profiles.length === 0) throw createProviderBridgeError(
    'PROVIDER_UNAVAILABLE',
    'RelayMe 登录成功，但账号没有可用模型',
  );
  await options.credentialStore.configure({ token });
  await configurationStore.write({
    ...configuration,
    profiles: mergeProfiles(profiles, configuration.profiles),
  });
}
```

The implementation may stage the next configuration before credential persistence, but must preserve current files on any pre-validation failure and use the repository's existing atomic stores. Both password login and web login call the same helper.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all selected tests pass; serialized errors contain neither old nor new tokens.

- [ ] **Step 5: Review diff without committing**

Verify the provider change does not alter direct generation URLs, task polling, image count, video fields, or history persistence.

### Task 3: Secure Official Login Window

**Files:**
- Create: `apps/desktop-modern/src/relayme-web-login.ts`
- Create: `apps/desktop-modern/src/relayme-web-login.test.ts`
- Modify: `apps/desktop-modern/src/main.ts`
- Modify: `apps/desktop-modern/src/runtime-entry-contract.test.ts`
- Modify: `apps/desktop-modern/src/packaging-boundary.test.ts`

**Interfaces:**
- Produces: `acquireRelayMeWebToken(options): Promise<string>`.
- Consumes: Electron `BrowserWindow`, a direct provider-specific session, and the current main window as modal parent.
- Supplies: `loginWebAccount: () => acquireRelayMeWebToken(...)` to `createRelayMeProviderService`.

- [ ] **Step 1: Write failing window-security tests**

Use small fake BrowserWindow/webContents objects to assert the constructor receives and loads exactly `https://www.ml.relayme.uk/workflow`:

```ts
expect(webPreferences).toMatchObject({
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
});
```

Assert the window loads exactly `https://www.ml.relayme.uk/`, denies popup creation, prevents cross-origin navigation, resolves only a bounded string from `localStorage.getItem('user_token')`, rejects on close with a sanitized cancellation error, rejects on timeout, and never returns page text, cookies, or storage objects.

Add a runtime contract assertion that the RelayMe service receives `loginWebAccount` and that the dedicated persistent web-login session uses the same direct proxy policy as RelayMe API requests.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run --config vitest.config.ts apps/desktop-modern/src/relayme-web-login.test.ts apps/desktop-modern/src/runtime-entry-contract.test.ts apps/desktop-modern/src/packaging-boundary.test.ts
```

Expected: module-not-found or missing `loginWebAccount` assertions.

- [ ] **Step 3: Implement the secure window**

Create a modal BrowserWindow with no preload, partition `persist:relayme-web-login`, and the secure preferences above. Before loading the page, clear only `localstorage` for origin `https://www.ml.relayme.uk` so a stale token cannot be accepted, while leaving official-session cookies isolated. Load exactly `https://www.ml.relayme.uk/workflow`, restrict accepted current URLs to that official origin; install `setWindowOpenHandler(() => ({ action: 'deny' }))`; prevent cross-origin `will-navigate`; poll this fixed expression only while the current origin is official:

```js
globalThis.localStorage.getItem('user_token')
```

Accept only strings with trimmed length from 1 through 16,384, clear timers/listeners on every terminal path, and destroy the auth window after resolution/rejection. Never log the expression result.

In `main.ts`, create the RelayMe auth session with direct proxy mode and inject `loginWebAccount`. Reuse the existing RelayMe provider fetch for post-login model validation.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all selected tests pass, including secure BrowserWindow settings and official-origin confinement.

- [ ] **Step 5: Review diff without committing**

Verify the auth window has no Canvas Atelier preload, no Node integration, no token logging, and no method that sends the token to renderer web contents.

### Task 4: Settings UI and Truthful Provider State

**Files:**
- Modify: `apps/renderer/src/settings/SettingsDrawer.tsx`
- Modify: `apps/renderer/src/settings/SettingsDrawer.test.tsx`
- Modify: `apps/renderer/src/test-mode/e2e-harness.ts`

**Interfaces:**
- Consumes: `window.novusDesktop.provider.loginRelayMeWeb(): Promise<ProviderActiveState>`.
- Produces: primary `使用 RelayMe 网页登录` action plus retained direct password form.
- Produces: status copy that distinguishes saved credential from a validated usable catalog.

- [ ] **Step 1: Write failing renderer tests**

Add a test that opens RelayMe login and clicks `使用 RelayMe 网页登录`, then asserts:

```ts
expect(loginRelayMeWeb).toHaveBeenCalledOnce();
expect(await screen.findByText('RelayMe 登录成功，已切换为当前活动供应商'))
  .toBeInTheDocument();
```

Add cancellation, timeout, and model-catalog failure tests with exact non-password messages. Add a stale-state test where `configured: true` and `listProfiles()` returns `[]`; assert the UI says `凭据待重新验证` rather than implying a usable RelayMe connection.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run --config vitest.config.ts apps/renderer/src/settings/SettingsDrawer.test.tsx
```

Expected: missing web-login button/API and stale-state copy assertions fail.

- [ ] **Step 3: Implement UI behavior**

Add a busy-safe `submitRelayMeWebLogin()` mirroring the refresh logic of password login without account/password arguments. Keep the dialog open for errors, refresh status and profiles after success, dispatch `novus:provider-catalog-changed`, and map sanitized errors to:

```ts
WEB_LOGIN_CANCELLED: 'RelayMe 网页登录已取消'
WEB_LOGIN_TIMEOUT: 'RelayMe 网页登录超时，请重试'
PROVIDER_INVALID_RESPONSE: 'RelayMe 网页登录未返回有效会话'
```

Retain the direct password fields under a secondary section. Derive stale status from `configured === true` plus zero usable profiles; do not alter Comfly status behavior.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all settings tests pass with no act warnings or secret values in snapshots.

- [ ] **Step 5: Review diff without committing**

Verify the renderer never receives, stores, or displays a RelayMe token and the password is still cleared after every direct-login attempt.

### Task 5: Integrated Verification and Installer

**Files:**
- Modify: `apps/desktop-modern/package.json`
- Modify: `package-lock.json`
- Modify only if required by focused failures: existing image-count, reverse-prompt, video, Photoshop, and packaging tests already changed in the dirty worktree.
- Remove after diagnosis: `tests/e2e/inspect-installed-relayme-credential.mjs`
- Remove after diagnosis: `tests/e2e/inspect-relayme-login-contract.mjs`
- Keep only if useful as a non-secret release smoke test: `tests/e2e/relayme-login-packaged-smoke.mjs`

**Interfaces:**
- Consumes: completed web-login bridge, provider validation, Electron window, and settings UI.
- Produces: next Windows installer and evidence report.

- [ ] **Step 1: Run focused joint capability tests**

Run provider contracts, RelayMe auth/service, preload, renderer settings, desktop runtime, image executor/job store, Photoshop runner/bridge, and packaging boundary tests. Expected: all pass without paid provider calls.

- [ ] **Step 2: Run complete validation**

Run:

```powershell
npm.cmd test
npm.cmd run build
```

Expected: zero test failures and successful typecheck/build for every workspace.

- [ ] **Step 3: Perform isolated packaged web-login QA**

Build unpacked output, launch it with a fresh QA data root, verify the official login window loads status 200, cross-origin navigation is blocked, cancellation is reported accurately, and a deliberately invalid session cannot become active. Do not use the user's credentials and do not run generation.

- [ ] **Step 4: Perform user-assisted real acceptance**

Ask the user to authenticate in the official window. Verify the returned active provider and non-empty catalog. Only after explicit generation approval, request two image outputs and confirm two distinct managed results. Separately verify reverse-prompt and video model visibility; do not claim generation capability from profile names alone.

- [ ] **Step 5: Build the next installer**

After acceptance, increment from `1.6.80` to the next unused patch version in both package files and run the established electron-builder command outside the restricted environment. Record installer path, byte size, SHA-256, signing status, and build timestamp.

- [ ] **Step 6: Final preservation and diff audit**

Confirm production user data was not modified by QA, no credential/token appears in source, logs, test output, or git diff, and all pre-existing unrelated worktree changes remain intact. Do not commit or push unless the user explicitly requests it.
