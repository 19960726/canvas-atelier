# RelayMe Official Web Login Design

## Goal

Allow Canvas Atelier users who can sign in on the RelayMe website but receive
an HTTP 401 from the desktop password request to authenticate through the
official RelayMe web application. A successful login must make the RelayMe
model catalog available before Canvas Atelier reports success.

The existing account-and-password form remains available as a fallback. This
change does not automatically submit a paid generation request.

## Verified Context

- RelayMe currently posts `username` and `password` to
  `https://www.ml.relayme.uk/api/auth/user/login`.
- The successful official response stores `data.token` as `user_token` and
  uses it as a bearer token.
- Canvas Atelier reaches that endpoint through its direct Electron network
  session. A deliberately invalid account receives the same HTTP 401 JSON
  response with and without browser-style headers.
- Renderer-to-main credential transport preserves the password value. The
  current user's provider credential file predates the latest login attempts,
  so its existence cannot represent a successful current login.

## User Flow

1. The RelayMe login dialog offers `使用 RelayMe 网页登录` as the primary
   action and retains the existing password form as a secondary path.
2. Canvas Atelier opens a dedicated modal browser window at the official
   RelayMe workflow URL `https://www.ml.relayme.uk/workflow` using a persistent,
   provider-specific Electron session.
3. The user signs in entirely inside the official RelayMe page. Canvas Atelier
   never reads the password entered into that page.
4. After the official page stores `user_token`, the desktop main process reads
   it from the isolated web contents context.
5. The main process validates the token by loading the RelayMe model catalog.
6. Only after model validation succeeds does Canvas Atelier encrypt and save
   the token, update profiles, activate RelayMe, close the login window, and
   report success.
7. Closing the window, timing out, receiving an invalid token, or failing model
   validation leaves the previous credential and active-provider state
   unchanged and shows a specific error.

## Architecture

### Renderer

Add a provider bridge command for official web login. The renderer receives
only the resulting active-provider state or a sanitized error. It never
receives the RelayMe token, page storage, cookies, or raw provider response.

The existing direct password login remains unchanged except for clearer status
copy. `configured` must not be presented as proof of a fresh login; when no
usable profiles exist, the UI identifies the saved credential as unverified or
expired and directs the user to log in again.

### Desktop Main Process

The main process owns the authentication window. It uses a dedicated
`persist:relayme-web-login` session and restricts navigation, popups, and token
acceptance to `https://www.ml.relayme.uk`.

Before each login attempt, Canvas Atelier clears only the official origin's
localStorage in this isolated session so an expired `user_token` cannot be
mistaken for a fresh login. Cookies remain owned by the isolated official web
session and are never copied into Canvas Atelier provider storage.

The window has no Node integration, uses context isolation and sandboxing, and
does not expose the Canvas Atelier preload bridge. Cross-origin navigation is
blocked or opened in the system browser only when explicitly safe.

The main process observes successful official authentication without logging
page contents. It reads only the `user_token` string, applies a length and
character sanity check, and immediately passes it to the provider service for
validation. The raw token is never sent to the renderer or written to logs.

### Provider Service

Add an internal token-login operation that reuses the existing model catalog
validation and atomic credential/configuration update. Password login and web
login converge on the same commit path so neither can report success before
models are usable.

Token validation accepts the opaque non-empty token shape used by the official
site instead of requiring a three-segment JWT. The model endpoint remains the
authority for whether a token is usable.

## Error Handling

- Window closed before login: `RelayMe 网页登录已取消`.
- Timeout: `RelayMe 网页登录超时，请重试`.
- Official page unavailable: network-specific message.
- Token missing or malformed: official-session-specific message.
- Token accepted by login page but model catalog rejects it: session expired or
  account/model permission message; do not call it a password error.
- Existing encrypted credential without usable profiles: show stale/unverified
  status, not a successful configured state.

All errors crossing IPC use existing sanitized provider error envelopes.

## Tests

- Contract tests for the new bridge request and response.
- Provider-service tests proving web tokens are validated before persistence,
  failed validation preserves old state, and opaque tokens are supported.
- Desktop main-process tests for official-origin confinement, secure window
  preferences, cancellation, timeout, and token extraction without renderer
  exposure.
- Renderer tests for the new primary action, busy/cancel/error states, and
  stale-credential copy.
- Focused provider/renderer/runtime tests, then the full test suite and build.
- Packaged isolated QA verifies the official login window opens and an invalid
  session cannot be reported as success. A real successful account login and
  paid image/video generation require the user to authenticate and explicitly
  authorize generation; they cannot be truthfully claimed from mocked tests.

## Release Acceptance

- The official RelayMe login window works outside the restricted build
  environment.
- A real user login results in a non-empty RelayMe model catalog.
- Image, reverse-prompt, and video model profiles are visible according to the
  provider response.
- Requesting two image outputs returns and persists two distinct image results.
- Existing projects, provider data, Photoshop integration files, and user
  credentials are not reset or overwritten during installation.
- The next installer has a new version, recorded size and SHA-256, and is
  clearly identified as signed or unsigned.
