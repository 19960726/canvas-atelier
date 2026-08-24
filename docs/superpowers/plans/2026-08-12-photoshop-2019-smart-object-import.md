# Photoshop 2019+ 智能对象导入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Windows 桌面版用户把已完成的生成图片原图安全导入当前 Photoshop 2019+ PSD/PSB，并创建为保持比例的嵌入式智能对象。

**Architecture:** Renderer 仅通过 `window.novusDesktop.projectImages.importToPhotoshop({ sessionId, assetId })` 提交不透明身份；Desktop Core 验证会话和受管资产后调用独立的 `PhotoshopSmartObjectService`。Windows 适配器负责发现 Photoshop、顺序执行固定 JSX 模板并返回稳定错误码，Renderer 只处理忙碌状态和中文提示。

**Tech Stack:** TypeScript、Electron IPC/contextBridge、Node.js `child_process`/`fs`/`path`、Photoshop ExtendScript/JSX、React、Vitest、Testing Library。

## Global Constraints

- 仅支持 Windows，最低 Photoshop 版本为 2019（主版本 20）。
- 只导入当前项目中的受管生成图片原图；不得接受 Renderer 提交的任意路径或脚本。
- 小图保持原始像素尺寸并居中；大图等比例缩小到活动画布范围内并居中。
- 创建嵌入式智能对象，不创建链接对象。
- 不拉伸、不裁切、不自动新建、保存、覆盖或关闭 PSD/PSB。
- 不读取、写入或替换系统剪贴板。
- 浏览器测试只允许显式 mock；正式完成必须经过 Windows + Photoshop 2019 和一个较新版本的实机验收。
- 当前工作树包含大量用户改动；每个任务只暂存该任务明确列出的文件，不得重置或覆盖无关改动。

## File Structure

- `packages/desktop-core/src/photoshop-contract.ts`：请求、响应、错误码和运行能力类型，以及纯校验器。
- `packages/desktop-core/src/photoshop-smart-object-service.ts`：会话资产验证、并发锁、适配器调用和错误映射。
- `packages/desktop-core/src/photoshop-windows-adapter.ts`：Windows Photoshop 安装发现、固定 JSX 生成、临时参数文件和顺序执行。
- `packages/desktop-core/src/photoshop-windows-runner.js`：固定 Windows Script Host 运行器，只连接已运行的 Photoshop COM 实例并执行应用自带 JSX。
- `packages/desktop-core/src/photoshop-place-smart-object.jsx`：受控的 Photoshop 2019+ 放置脚本模板，不接收自由脚本。
- `packages/desktop-core/src/contracts.ts`、`preload-api.ts`、`bridge-handlers.ts`、`index.ts`：接入既有桌面桥接。
- `apps/desktop-modern/src/main.ts`、`apps/desktop-legacy/src/main.ts`：创建 Windows 适配器并注入 Desktop Core。
- `apps/renderer/src/app/photoshop-import.ts`：Renderer 侧能力判断、错误文案和调用封装。
- `apps/renderer/src/canvas/ModuleNodeCard.tsx`：启用现有图片右键菜单动作。

---

### Task 1: 定义 Photoshop 桥接合约

**Files:**
- Create: `packages/desktop-core/src/photoshop-contract.ts`
- Create: `packages/desktop-core/src/photoshop-contract.test.ts`
- Modify: `packages/desktop-core/src/contracts.ts`
- Modify: `packages/desktop-core/src/index.ts`

**Interfaces:**
- Produces: `PhotoshopImportRequest`, `PhotoshopImportErrorCode`, `PhotoshopImportResult`, `PhotoshopCapability`, `parsePhotoshopImportRequest(value)`。
- `PhotoshopImportRequest` 只能包含 `{ sessionId: string; assetId: string }`。

- [ ] **Step 1: 写失败的合约测试**

```ts
import { describe, expect, it } from 'vitest';
import { parsePhotoshopImportRequest } from './photoshop-contract.js';

describe('parsePhotoshopImportRequest', () => {
  it('accepts only opaque session and managed asset identities', () => {
    expect(parsePhotoshopImportRequest({
      sessionId: 'session-1',
      assetId: '0123456789abcdef',
    })).toEqual({ sessionId: 'session-1', assetId: '0123456789abcdef' });
  });

  it.each([
    { sessionId: 'session-1', assetId: '0123456789abcdef', path: 'C:/secret.png' },
    { sessionId: 'session-1', assetId: '0123456789abcdef', script: 'app.activeDocument.save()' },
    { sessionId: '', assetId: '0123456789abcdef' },
    { sessionId: 'session-1', assetId: '../outside' },
  ])('rejects unsafe input %#', (input) => {
    expect(() => parsePhotoshopImportRequest(input)).toThrow();
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm.cmd test -- packages/desktop-core/src/photoshop-contract.test.ts`

Expected: FAIL，因为 `photoshop-contract.ts` 尚不存在。

- [ ] **Step 3: 实现最小合约**

```ts
import { z } from 'zod';

export const PHOTOSHOP_IMPORT_ERROR_CODES = [
  'desktop_bridge_unavailable',
  'asset_not_found',
  'asset_not_owned',
  'unsupported_media',
  'photoshop_not_installed',
  'photoshop_not_running',
  'photoshop_version_unsupported',
  'no_active_document',
  'automation_denied',
  'placement_failed',
  'import_busy',
] as const;

export type PhotoshopImportErrorCode = typeof PHOTOSHOP_IMPORT_ERROR_CODES[number];

export interface PhotoshopImportRequest {
  readonly sessionId: string;
  readonly assetId: string;
}

export type PhotoshopImportResult =
  | { readonly ok: true; readonly layerName: string }
  | { readonly ok: false; readonly code: PhotoshopImportErrorCode };

export interface PhotoshopCapability {
  readonly available: boolean;
  readonly code?: PhotoshopImportErrorCode;
}

const requestSchema = z.object({
  sessionId: z.string().trim().min(1).max(160),
  assetId: z.string().regex(/^[a-f0-9]{16}$/u),
}).strict();

export function parsePhotoshopImportRequest(value: unknown): PhotoshopImportRequest {
  return requestSchema.parse(value);
}
```

在 `contracts.ts` 和 `index.ts` 中只做显式类型导出，不复制第二套类型。

- [ ] **Step 4: 运行合约测试与类型检查**

Run: `npm.cmd test -- packages/desktop-core/src/photoshop-contract.test.ts`

Expected: PASS。

Run: `npx.cmd tsc -p packages/desktop-core/tsconfig.json --noEmit`

Expected: 0 errors。

- [ ] **Step 5: 提交**

```powershell
git add -- packages/desktop-core/src/photoshop-contract.ts packages/desktop-core/src/photoshop-contract.test.ts packages/desktop-core/src/contracts.ts packages/desktop-core/src/index.ts
git commit -m "feat: define Photoshop import contract"
```

### Task 2: 实现受管资产验证与并发服务

**Files:**
- Create: `packages/desktop-core/src/photoshop-smart-object-service.ts`
- Create: `packages/desktop-core/src/photoshop-smart-object-service.test.ts`

**Interfaces:**
- Consumes: `PhotoshopImportRequest`, `PhotoshopImportResult`。
- Produces: `PhotoshopSmartObjectAdapter`, `PhotoshopManagedAssetResolver`, `PhotoshopSmartObjectService.import(request)`。

- [ ] **Step 1: 写失败的服务测试**

```ts
import { describe, expect, it, vi } from 'vitest';
import { PhotoshopSmartObjectService } from './photoshop-smart-object-service.js';

describe('PhotoshopSmartObjectService', () => {
  it('resolves a managed original and imports it once', async () => {
    const place = vi.fn().mockResolvedValue({ ok: true, layerName: 'Nano Banana 2' });
    const service = new PhotoshopSmartObjectService({
      resolve: vi.fn().mockResolvedValue({
        absolutePath: 'E:/managed/0123456789abcdef.png',
        label: 'Nano Banana 2',
        mediaType: 'image/png',
      }),
    }, { place });

    await expect(service.import({ sessionId: 'session-1', assetId: '0123456789abcdef' }))
      .resolves.toEqual({ ok: true, layerName: 'Nano Banana 2' });
    expect(place).toHaveBeenCalledTimes(1);
  });

  it('returns import_busy for a duplicate in-flight request', async () => {
    let finish!: () => void;
    const place = vi.fn(() => new Promise((resolve) => { finish = () => resolve({ ok: true, layerName: 'Layer' }); }));
    const service = new PhotoshopSmartObjectService({
      resolve: vi.fn().mockResolvedValue({ absolutePath: 'E:/managed/a.png', label: 'Layer', mediaType: 'image/png' }),
    }, { place });
    const first = service.import({ sessionId: 'session-1', assetId: '0123456789abcdef' });
    await expect(service.import({ sessionId: 'session-1', assetId: '0123456789abcdef' }))
      .resolves.toEqual({ ok: false, code: 'import_busy' });
    finish();
    await first;
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm.cmd test -- packages/desktop-core/src/photoshop-smart-object-service.test.ts`

Expected: FAIL，因为服务尚不存在。

- [ ] **Step 3: 实现最小服务**

```ts
export interface PhotoshopManagedAsset {
  readonly absolutePath: string;
  readonly label: string;
  readonly mediaType: string;
}

export interface PhotoshopManagedAssetResolver {
  resolve(request: PhotoshopImportRequest): Promise<PhotoshopManagedAsset | null>;
}

export interface PhotoshopSmartObjectAdapter {
  place(input: { readonly absolutePath: string; readonly layerName: string }): Promise<PhotoshopImportResult>;
}

export class PhotoshopSmartObjectService {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly assets: PhotoshopManagedAssetResolver,
    private readonly adapter: PhotoshopSmartObjectAdapter,
  ) {}

  async import(request: PhotoshopImportRequest): Promise<PhotoshopImportResult> {
    const key = `${request.sessionId}:${request.assetId}`;
    if (this.inFlight.has(key)) return { ok: false, code: 'import_busy' };
    this.inFlight.add(key);
    try {
      const asset = await this.assets.resolve(request);
      if (asset === null) return { ok: false, code: 'asset_not_found' };
      if (!asset.mediaType.startsWith('image/')) return { ok: false, code: 'unsupported_media' };
      return await this.adapter.place({ absolutePath: asset.absolutePath, layerName: sanitizeLayerName(asset.label) });
    } catch {
      return { ok: false, code: 'placement_failed' };
    } finally {
      this.inFlight.delete(key);
    }
  }
}
```

`sanitizeLayerName` 去除控制字符，把空名称回退为“生成图片”，最大长度 120。

- [ ] **Step 4: 补齐资产缺失、非图片、适配器错误和锁释放测试并运行**

Run: `npm.cmd test -- packages/desktop-core/src/photoshop-smart-object-service.test.ts`

Expected: PASS，覆盖成功、缺失、非图片、异常和重复提交。

- [ ] **Step 5: 提交**

```powershell
git add -- packages/desktop-core/src/photoshop-smart-object-service.ts packages/desktop-core/src/photoshop-smart-object-service.test.ts
git commit -m "feat: add managed Photoshop import service"
```

### Task 3: 实现 Photoshop 2019+ 固定脚本与尺寸算法

**Files:**
- Create: `packages/desktop-core/src/photoshop-place-smart-object.jsx`
- Create: `packages/desktop-core/src/photoshop-script.ts`
- Create: `packages/desktop-core/src/photoshop-script.test.ts`

**Interfaces:**
- Produces: `createPhotoshopPlacementPayload(input)` 和固定 JSX 脚本。
- Payload 只包含 Base64 编码的原图路径与图层名；脚本不执行 payload 中的代码。

- [ ] **Step 1: 写失败的脚本契约测试**

```ts
import { describe, expect, it } from 'vitest';
import { createPhotoshopPlacementPayload } from './photoshop-script.js';

describe('Photoshop placement script contract', () => {
  it('encodes path and layer name as data instead of executable source', () => {
    const payload = createPhotoshopPlacementPayload({
      absolutePath: 'E:/image/quote\";app.activeDocument.save();//.png',
      layerName: 'Generated\nLayer',
    });
    expect(payload).not.toContain('app.activeDocument.save()');
    expect(JSON.parse(payload)).toEqual(expect.objectContaining({ version: 1 }));
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm.cmd test -- packages/desktop-core/src/photoshop-script.test.ts`

Expected: FAIL，因为脚本模块尚不存在。

- [ ] **Step 3: 实现安全 payload 与固定 JSX**

```ts
export function createPhotoshopPlacementPayload(input: {
  readonly absolutePath: string;
  readonly layerName: string;
}): string {
  return JSON.stringify({
    version: 1,
    imagePathBase64: Buffer.from(input.absolutePath, 'utf8').toString('base64'),
    layerNameBase64: Buffer.from(input.layerName, 'utf8').toString('base64'),
  });
}
```

固定 JSX 的关键算法必须是：

```js
var documentRef = app.activeDocument;
var layer = placeEmbedded(imageFile);
var bounds = layer.bounds;
var layerWidth = bounds[2].as('px') - bounds[0].as('px');
var layerHeight = bounds[3].as('px') - bounds[1].as('px');
var canvasWidth = documentRef.width.as('px');
var canvasHeight = documentRef.height.as('px');
var scale = Math.min(1, canvasWidth / layerWidth, canvasHeight / layerHeight);
if (scale < 1) layer.resize(scale * 100, scale * 100, AnchorPosition.MIDDLECENTER);
centerLayerInDocument(layer, documentRef);
```

脚本不得包含 `save`、`saveAs`、`close`、`documents.add`、linked smart object 操作或剪贴板调用。

- [ ] **Step 4: 添加静态禁止项测试并运行**

```ts
expect(scriptSource).not.toMatch(/saveAs|documents\.add|clipboard|placedLayerRelinkToFile/iu);
expect(scriptSource).toContain("executeAction(charIDToTypeID('Plc ')");
```

Run: `npm.cmd test -- packages/desktop-core/src/photoshop-script.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add -- packages/desktop-core/src/photoshop-place-smart-object.jsx packages/desktop-core/src/photoshop-script.ts packages/desktop-core/src/photoshop-script.test.ts
git commit -m "feat: add confined Photoshop placement script"
```

### Task 4: 实现 Windows Photoshop 发现与串行适配器

**Files:**
- Create: `packages/desktop-core/src/photoshop-windows-adapter.ts`
- Create: `packages/desktop-core/src/photoshop-windows-adapter.test.ts`
- Create: `packages/desktop-core/src/photoshop-windows-runner.js`

**Interfaces:**
- Consumes: `PhotoshopSmartObjectAdapter` 和 Task 3 的固定脚本 payload。
- Produces: `createWindowsPhotoshopSmartObjectAdapter(dependencies)`。

- [ ] **Step 1: 写失败的发现与执行测试**

```ts
it('prefers the highest running supported Photoshop version', async () => {
  const adapter = createWindowsPhotoshopSmartObjectAdapter({
    platform: 'win32',
    discoverInstallations: async () => [
      { majorVersion: 20, executablePath: 'PS2019.exe' },
      { majorVersion: 25, executablePath: 'PS2024.exe' },
    ],
    inspectRunningInstance: async () => ({ majorVersion: 25, activeDocument: true }),
    execute: vi.fn().mockResolvedValue({ activeDocument: true, layerName: 'Layer' }),
    temporaryFiles: fakeTemporaryFiles(),
  });
  await expect(adapter.place({ absolutePath: 'E:/managed/a.png', layerName: 'Layer' }))
    .resolves.toEqual({ ok: true, layerName: 'Layer' });
});
```

另写测试覆盖非 Windows、未安装、仅旧版本、未运行、运行版本低于 20、无活动文档、自动化拒绝和临时文件清理。

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm.cmd test -- packages/desktop-core/src/photoshop-windows-adapter.test.ts`

Expected: FAIL，因为适配器尚不存在。

- [ ] **Step 3: 实现串行适配器**

适配器内部使用一个 Promise 队列：

```ts
let queue = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(() => undefined, () => undefined);
  return run;
}
```

安装发现只读取以下固定注册表位置，不扫描用户目录：

```text
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Photoshop.exe
HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\Photoshop.exe
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall
HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall
```

固定 WSH 运行器通过 `GetObject('', 'Photoshop.Application')` 只连接已运行实例，读取 `app.version` 和 `app.documents.length`，然后调用 `app.DoJavaScriptFile(jsxPath)`。它不得使用 `new ActiveXObject` 启动 Photoshop。未安装返回 `photoshop_not_installed`；已安装但 `GetObject` 失败返回 `photoshop_not_running`；运行版本主版本小于 20 返回 `photoshop_version_unsupported`；`documents.length === 0` 返回 `no_active_document`。

执行前创建私有临时目录，写入应用自带的固定 JSX 副本和 JSON payload；用固定参数数组调用 `%SystemRoot%\System32\cscript.exe //B //NoLogo photoshop-windows-runner.js <jsxPath> <payloadPath>`，禁止拼接 shell 命令。无论成功失败都清理临时目录。

- [ ] **Step 4: 运行适配器测试**

Run: `npm.cmd test -- packages/desktop-core/src/photoshop-windows-adapter.test.ts`

Expected: PASS，且并发测试证明两个不同图片的自动化调用按顺序执行。

- [ ] **Step 5: 提交**

```powershell
git add -- packages/desktop-core/src/photoshop-windows-adapter.ts packages/desktop-core/src/photoshop-windows-adapter.test.ts packages/desktop-core/src/photoshop-windows-runner.js
git commit -m "feat: add Windows Photoshop adapter"
```

### Task 5: 接入 Desktop Core 资产仓库和 IPC

**Files:**
- Modify: `packages/desktop-core/src/preload-api.ts`
- Modify: `packages/desktop-core/src/preload-api.test.ts`
- Modify: `packages/desktop-core/src/bridge-handlers.ts`
- Create: `packages/desktop-core/src/photoshop-bridge.test.ts`
- Modify: `packages/desktop-core/src/index.ts`

**Interfaces:**
- Consumes: `PhotoshopSmartObjectService.import(request)`。
- Produces: `BRIDGE_CHANNELS.importProjectImageToPhotoshop`、`DesktopProjectImageBridgeApi.importToPhotoshop(request)`、`DesktopBridgeHandlers.importProjectImageToPhotoshop(event, request)`。

- [ ] **Step 1: 写失败的 preload 和 handler 测试**

```ts
it('invokes the confined Photoshop channel with identities only', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, layerName: 'Layer' });
  const api = createPreloadApi(invoke);
  await api.projectImages.importToPhotoshop({ sessionId: 'session-1', assetId: '0123456789abcdef' });
  expect(invoke).toHaveBeenCalledWith(
    BRIDGE_CHANNELS.importProjectImageToPhotoshop,
    { sessionId: 'session-1', assetId: '0123456789abcdef' },
  );
});
```

Handler 测试创建一个包含匹配图片资产的打开会话，断言 `AssetStore.resolvePath` 收到项目根、`assetId`、扩展名、sha256 和 byteSize；不存在、视频资产或跨项目 ID 返回固定失败结果。

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm.cmd test -- packages/desktop-core/src/preload-api.test.ts packages/desktop-core/src/photoshop-bridge.test.ts`

Expected: FAIL，因为通道和方法尚未定义。

- [ ] **Step 3: 实现桥接**

在 `DesktopBridgeOptions` 增加：

```ts
readonly photoshopSmartObjectAdapter?: PhotoshopSmartObjectAdapter;
```

`createDesktopBridgeHandlers` 内部用现有 `sessions`、`repository` 和 `assetStore` 创建 `PhotoshopManagedAssetResolver`，再构造一个 `PhotoshopSmartObjectService`。Resolver 使用 `requireSession` 取得会话、`repository.readCurrentProject` 查找 `project.assets` 中相同 `assetId` 的图片元数据，再调用 `assetStore.resolvePath(...)`。只有路径校验成功后才返回 `{ absolutePath, label, mediaType }`；Handler 本身只解析请求并调用 `photoshopSmartObjectService.import(validated)`。

注册：

```ts
ipcMain.handle(
  BRIDGE_CHANNELS.importProjectImageToPhotoshop,
  handlers.importProjectImageToPhotoshop,
);
```

- [ ] **Step 4: 运行桥接回归**

Run: `npm.cmd test -- packages/desktop-core/src/preload-api.test.ts packages/desktop-core/src/photoshop-bridge.test.ts packages/desktop-core/src/project-image-bridge.test.ts packages/desktop-core/src/bridge-contract.test.ts`

Expected: PASS，现有图片上传、粘贴和列表桥接不回退。

- [ ] **Step 5: 提交**

```powershell
git add -- packages/desktop-core/src/preload-api.ts packages/desktop-core/src/preload-api.test.ts packages/desktop-core/src/bridge-handlers.ts packages/desktop-core/src/photoshop-bridge.test.ts packages/desktop-core/src/index.ts
git commit -m "feat: expose Photoshop import bridge"
```

### Task 6: 在现代版和兼容版桌面入口注入适配器

**Files:**
- Modify: `apps/desktop-modern/src/main.ts`
- Modify: `apps/desktop-legacy/src/main.ts`
- Modify: `apps/desktop-modern/src/runtime-entry-contract.test.ts`
- Modify: `apps/desktop-legacy/src/runtime-entry-contract.test.ts`
- Modify: `apps/desktop-modern/scripts/copy-static.mjs`
- Modify: `apps/desktop-legacy/scripts/copy-static.mjs`

**Interfaces:**
- Consumes: `createWindowsPhotoshopSmartObjectAdapter`、`PhotoshopSmartObjectService`。
- Produces: 两个桌面入口都注入真实 Windows 适配器，构建产物包含固定 JSX 和固定 WSH 运行器。

- [ ] **Step 1: 写失败的桌面入口合约测试**

断言两个 `main.ts` 都创建 Windows Photoshop 适配器并传给 `createDesktopBridgeHandlers`，两个 `copy-static.mjs` 都复制 `photoshop-place-smart-object.jsx` 和 `photoshop-windows-runner.js` 到运行时资源目录。

```ts
expect(mainSource).toContain('createWindowsPhotoshopSmartObjectAdapter');
expect(mainSource).toContain('photoshopSmartObjectAdapter');
expect(copyStaticSource).toContain('photoshop-place-smart-object.jsx');
expect(copyStaticSource).toContain('photoshop-windows-runner.js');
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm.cmd test -- apps/desktop-modern/src/runtime-entry-contract.test.ts apps/desktop-legacy/src/runtime-entry-contract.test.ts`

Expected: FAIL，因为入口尚未注入。

- [ ] **Step 3: 实现入口注入与资源复制**

两个入口使用同一工厂：

```ts
const photoshopSmartObjectAdapter = createWindowsPhotoshopSmartObjectAdapter({
  platform: process.platform,
  jsxResourcePath: join(process.resourcesPath, 'photoshop-place-smart-object.jsx'),
  runnerResourcePath: join(process.resourcesPath, 'photoshop-windows-runner.js'),
});
```

如果当前平台不是 Windows，工厂返回 `desktop_bridge_unavailable`，不得在模块加载阶段执行 PowerShell、Photoshop 或文件写入。

- [ ] **Step 4: 运行入口测试和桌面类型检查**

Run: `npm.cmd test -- apps/desktop-modern/src/runtime-entry-contract.test.ts apps/desktop-legacy/src/runtime-entry-contract.test.ts`

Expected: PASS。

Run: `npx.cmd tsc -p apps/desktop-modern/tsconfig.json --noEmit`

Run: `npx.cmd tsc -p apps/desktop-legacy/tsconfig.json --noEmit`

Expected: 两个命令均 0 errors。

- [ ] **Step 5: 提交**

```powershell
git add -- apps/desktop-modern/src/main.ts apps/desktop-legacy/src/main.ts apps/desktop-modern/src/runtime-entry-contract.test.ts apps/desktop-legacy/src/runtime-entry-contract.test.ts apps/desktop-modern/scripts/copy-static.mjs apps/desktop-legacy/scripts/copy-static.mjs
git commit -m "feat: wire Photoshop bridge into desktop apps"
```

### Task 7: 实现 Renderer 调用封装和中文提示

**Files:**
- Create: `apps/renderer/src/app/photoshop-import.ts`
- Create: `apps/renderer/src/app/photoshop-import.test.ts`
- Modify: `apps/renderer/src/app/desktop-persistence.ts`

**Interfaces:**
- Consumes: `window.novusDesktop.projectImages.importToPhotoshop` 和 `ProjectPersistenceClient.getSessionId()`。
- Produces: `getPhotoshopImportAvailability(asset, sessionId)`、`importGeneratedImageToPhotoshop(asset, sessionId)`、`photoshopImportMessage(result)`。

- [ ] **Step 1: 写失败的 Renderer 封装测试**

```ts
it('maps bridge failures to actionable Chinese copy', () => {
  expect(photoshopImportMessage({ ok: false, code: 'no_active_document' }))
    .toBe('请先在 Photoshop 中打开 PSD 或 PSB 文档');
});

it('never submits a display URL or local path', async () => {
  const importToPhotoshop = vi.fn().mockResolvedValue({ ok: true, layerName: 'Layer' });
  window.novusDesktop = createDesktopMock({ projectImages: { importToPhotoshop } });
  await importGeneratedImageToPhotoshop(projectImage, 'session-1');
  expect(importToPhotoshop).toHaveBeenCalledWith({
    sessionId: 'session-1',
    assetId: projectImage.assetId,
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm.cmd test -- apps/renderer/src/app/photoshop-import.test.ts`

Expected: FAIL，因为封装模块尚不存在。

- [ ] **Step 3: 实现封装**

```ts
export async function importGeneratedImageToPhotoshop(
  asset: ProjectImageAssetSummary,
  sessionId: string | null,
): Promise<PhotoshopImportResult> {
  const bridge = window.novusDesktop?.projectImages.importToPhotoshop;
  if (bridge === undefined || sessionId === null) {
    return { ok: false, code: 'desktop_bridge_unavailable' };
  }
  return bridge({ sessionId, assetId: asset.assetId });
}
```

在 `desktop-persistence.ts` 增加只读导出 `getActiveProjectSessionId(): string | null`，返回当前持久化客户端的 `getSessionId?.() ?? null`；菜单不能从 React 状态推测或自行构造 session ID。错误文案必须与设计规格中的表格逐项一致。

- [ ] **Step 4: 运行测试**

Run: `npm.cmd test -- apps/renderer/src/app/photoshop-import.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add -- apps/renderer/src/app/photoshop-import.ts apps/renderer/src/app/photoshop-import.test.ts apps/renderer/src/app/desktop-persistence.ts
git commit -m "feat: add renderer Photoshop import client"
```

### Task 8: 启用生成图片右键菜单动作

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/styles/app.css`

**Interfaces:**
- Consumes: Task 7 的 Renderer 封装。
- Produces: 可用的“导入 Photoshop（智能对象）”菜单项、单次提交、忙碌态和中文结果通知。

- [ ] **Step 1: 写失败的交互测试**

```ts
it('imports the selected generated original to Photoshop once', async () => {
  const importToPhotoshop = vi.fn().mockResolvedValue({ ok: true, layerName: 'Generated image' });
  window.novusDesktop = createDesktopMock({ projectImages: { importToPhotoshop } });
  setDesktopSessionId('session-1');
  renderGeneratedImageNodeWithResult(projectImage);
  fireEvent.contextMenu(screen.getByRole('img', { name: projectImage.label }));
  const action = screen.getByRole('menuitem', { name: '导入 Photoshop（智能对象）' });
  fireEvent.click(action);
  fireEvent.click(action);
  await waitFor(() => expect(importToPhotoshop).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('已导入当前 Photoshop 文档')).toBeVisible();
});
```

另写测试覆盖浏览器模式禁用、无活动文档中文提示、菜单关闭和复制图片功能仍可用。

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm.cmd test -- apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

Expected: Photoshop 菜单相关新测试 FAIL，因为按钮仍是禁用占位。

- [ ] **Step 3: 实现菜单忙碌态**

`GeneratedImageActionMenu` 增加局部状态：

```ts
const [photoshopBusy, setPhotoshopBusy] = useState(false);
const [photoshopMessage, setPhotoshopMessage] = useState<string | null>(null);
```

按钮文案：空闲为“导入 Photoshop（智能对象）”，执行中为“正在导入…”。调用成功后显示“已导入当前 Photoshop 文档”，失败显示 Task 7 映射的中文提示。按钮和图标使用现有菜单行高、居中规则和深浅主题 token，不新增突兀颜色。

- [ ] **Step 4: 运行节点与样式回归**

Run: `npm.cmd test -- apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/main.styles.test.ts`

Expected: PASS，复制、下载、发送 Agent、双击预览均不回退。

- [ ] **Step 5: 提交**

```powershell
git add -- apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/styles/app.css
git commit -m "feat: enable Photoshop image action"
```

### Task 9: 浏览器 mock、全量回归和 Windows 实机验收

**Files:**
- Modify: `apps/renderer/src/test-mode/manual-acceptance-bridge.ts`
- Modify: `apps/renderer/src/test-mode/manual-acceptance-bridge.test.ts`
- Create: `tests/e2e/photoshop-image-action.spec.ts`
- Create: `docs/qa/photoshop-2019-smart-object-checklist.md`

**Interfaces:**
- Produces: 浏览器显式 mock、自动化回归证据和实机验收清单。

- [ ] **Step 1: 写失败的浏览器 E2E**

```ts
test('generated image menu submits the mocked Photoshop action', async ({ page }) => {
  await openManualAcceptanceCanvas(page);
  await seedGeneratedImageResult(page);
  await page.getByRole('img', { name: 'Generated result 1' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '导入 Photoshop（智能对象）' }).click();
  await expect(page.getByText('已导入当前 Photoshop 文档')).toBeVisible();
});
```

- [ ] **Step 2: 运行 E2E 并确认失败**

Run: `npx.cmd playwright test tests/e2e/photoshop-image-action.spec.ts`

Expected: FAIL，因为手工验收 bridge 尚未提供显式 Photoshop mock。

- [ ] **Step 3: 添加显式 mock 与实机清单**

Mock 只返回固定结果，不读取路径、不启动 Photoshop，并带 `mock: true` 测试标记。实机清单逐项记录 Photoshop 2019 和较新版本、PSD/PSB、横竖方图、大小图、未运行、无活动文档、智能对象类型、居中和剪贴板未变化。

- [ ] **Step 4: 运行自动化验证**

Run: `npm.cmd test -- packages/desktop-core/src/photoshop-contract.test.ts packages/desktop-core/src/photoshop-smart-object-service.test.ts packages/desktop-core/src/photoshop-script.test.ts packages/desktop-core/src/photoshop-windows-adapter.test.ts packages/desktop-core/src/photoshop-bridge.test.ts packages/desktop-core/src/preload-api.test.ts apps/renderer/src/app/photoshop-import.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/test-mode/manual-acceptance-bridge.test.ts`

Expected: PASS。

Run: `npx.cmd tsc -p packages/desktop-core/tsconfig.json --noEmit`

Run: `npx.cmd tsc -p apps/renderer/tsconfig.json --noEmit`

Run: `npx.cmd playwright test tests/e2e/photoshop-image-action.spec.ts`

Expected: 所有命令 0 errors / PASS。

- [ ] **Step 5: 构建桌面产物并检查固定脚本被打包**

Run: `npm.cmd run build -w @agent-canvas/desktop-core`

Run: `npm.cmd run build -w @agent-canvas/renderer`

Run: `npm.cmd run build -w @agent-canvas/desktop-modern`

Expected: 构建成功，桌面资源目录存在 `photoshop-place-smart-object.jsx` 和 `photoshop-windows-runner.js`，且源码扫描不包含用户绝对路径、密钥或任意 Renderer 脚本入口。

- [ ] **Step 6: Windows Photoshop 实机验收**

按照 `docs/qa/photoshop-2019-smart-object-checklist.md` 执行。未安装 Photoshop 2019 或较新版本、未打开真实 PSD/PSB 时，明确记录“实机验收未执行”，不得声称正式完成。

- [ ] **Step 7: 提交**

```powershell
git add -- apps/renderer/src/test-mode/manual-acceptance-bridge.ts apps/renderer/src/test-mode/manual-acceptance-bridge.test.ts tests/e2e/photoshop-image-action.spec.ts docs/qa/photoshop-2019-smart-object-checklist.md
git commit -m "test: verify Photoshop smart object workflow"
```

## Final Verification Gate

- [ ] `git diff --check` 无空白或冲突标记错误。
- [ ] Photoshop 专项 Vitest 全通过。
- [ ] Desktop Core、Renderer、现代版和兼容版 TypeScript 检查全通过。
- [ ] Photoshop 浏览器 mock E2E 通过，但报告中明确它不等于真实 Photoshop 验收。
- [ ] Windows Photoshop 2019 和较新版本实机清单全部签核。
- [ ] 导入前后复制图片、复制视频、Agent 粘贴和画布粘贴回归通过。
- [ ] 只有以上全部完成后，才可把原右键占位项标记为正式可用并进入 NSIS 正式安装包验收。
