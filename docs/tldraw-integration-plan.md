# tldraw 接入方案（保持现有协作同步体系可用）

> 背景：我们计划在编辑器中接入 [tldraw](https://github.com/tldraw/tldraw) 白板。
> 约束：**不引入第二套同步协议** —— v2 协作体系（Yjs + y-partyserver DO、
> ticket 鉴权、快照持久化、离线 outbox、durable-ack、presence、R2 二进制 GC、
> 空闲 TTL）必须原样继续工作。

## 0. 两个先决事实（2026-08 核实）

### 许可证是硬门槛

tldraw SDK 4.x（2025-09 起）改为 **生产环境必须持有 license key**，无 key 时仅开发环境可用：

| 类型 | 水印 | 费用 |
|------|------|------|
| Trial | 无 | 100 天评估（每公司一次） |
| Hobby | **有** | 免费（非商业） |
| Commercial | 无 | 付费（社区报价约 $6k/年，创业公司另有档位） |

- 打包后的 Tauri 应用属于 production（HTTPS 非 localhost + NODE_ENV=production 检测），**必须先决定买 Commercial 还是接受 Hobby 水印**，否则一切免谈。
- key 通过 `<Tldraw licenseKey={...}>` 或 `VITE_TLDRAW_LICENSE_KEY` 注入，客户端校验、可离线。
- 若许可证不可接受，MIT 的 Excalidraw 是替代路线（同样走本文的 Yjs 桥接思路，但 Store 桥接生态更弱）。

来源：[tldraw license key 文档](https://tldraw.dev/sdk-features/license-key)、
[tldraw license 页面](https://tldraw.dev/community/license)、
[SDK 4.0 发布说明](https://appdevelopermagazine.com/tldraw-sdk-4-0-release-new-starter-kits-and-licensing-model/)。

### 没有官方 Yjs 包

`@tldraw/yjs` / `useYjsStore` 是 LLM 幻觉，**不存在**（tldraw 官方博客
[“20 things I wish AI chatbots knew about tldraw”](https://tldraw.dev/blog/20-things-i-wish-ai-chatbots-knew-about-tldraw)
专门辟谣）。真实选项：

- **A. `@tldraw/sync`（TLSocketRoom）**：官方、服务端权威、**不是 CRDT**，参考后端是 Cloudflare DO；
- **B. 自带 Yjs 桥接**：用 tldraw Store 的 change listener 自己桥，官方明确支持这条路线
  （“you can pair tldraw with Yjs if your stack already depends on it”），tldraw 自己的
  [y-partykit 示例](https://blog.partykit.io/posts/ai-interactions-with-tldraw/)和社区
  [tlsync-yjs](https://github.com/shahriar-shojib/tlsync-yjs) 可作参考实现。

## 1. 路线选择：B（Yjs 桥接），理由

| 维度 | A. tldraw sync (TLSocketRoom) | B. Yjs 桥接（推荐） |
|------|-------------------------------|---------------------|
| 同步协议 | 第二套（服务端权威 diff/patch） | **复用现有 y-sync，零新协议** |
| 离线编辑 | 不支持（服务端权威=离线只读） | **复用我们的 outbox + durable-ack，离线可编辑** |
| 鉴权/ticket | 需另接 | 复用 socket ticket |
| 持久化/GC/TTL | 需另建 | 复用 DO 快照 + R2 GC + 空闲 TTL |
| 冲突语义 | 服务端裁决 | 与文本文件一致的 CRDT 合并 |
| 工作量 | 新 DO + 新客户端链路 | 一个桥接模块 + kind 扩展 |

关键点：**TextFileV2 DO 同步的是整个 Y.Doc**（y-sync 协议对文档结构无感）。
文本文件把内容放在 `doc.getText("content")`；白板文件改放
`doc.getMap("records")`（record id → TLRecord JSON）。服务端 95% 的代码
（onSave 快照、durable-ack、限流、fencing、destroyForExpiry）完全不用动。

## 2. 服务端改动（小）

1. **文件 kind 扩展**：`CatalogFileV2["kind"]` 增加 `"board"`：
   - `collab-server/src/project-coordinator-v2.ts` `requiredFileKind` 放行 `"board"`；
   - `protocol/collab-v2.ts` 类型与校验同步；
   - `authorizeTextImport` / `completeTextImport` 的 kind 检查从 `=== "text"` 放宽到 text|board。
2. **board 导入**：`TextFileV2.initializeImport` 目前把字节 decode 成 UTF-8 插进
   `getText("content")`。board 走另一条：字节是 `.tldr` JSON → 解析出 records →
   逐条 `doc.getMap("records").set(id, record)`。快照/导出逻辑天然通用。
3. **限流核对**：白板 presence（指针移动）峰值 ~30–60fps，但 tldraw 有节流，
   稳态约 10–15/s < `MAX_AWARENESS_PER_MINUTE`（900/min=15/s）。先观察，必要时按 kind 调。
4. **体积**：`MAX_DOCUMENT_BYTES` 5MB ≈ 数千个 shape 的 Yjs 更新，够用；单帧 1MB 远超单条 record 更新。

## 3. 客户端改动（主体）

### 3.1 Store ↔ Y.Map 桥接（新增 `src/tldraw-yjs-bridge.ts`，~300 行）

照 tldraw y-partykit 示例的模式，但桥到我们的 `CollabTextClientV2` **本地 doc**：

```
tldraw Store ──store.listen──▶ diff records ──▶ yMap.transact(put/delete, origin=LOCAL)
                                                        │  （我们现有的 outbox/durable-ack/网络发布链路接管）
tldraw Store ◀──mergeRemoteChanges── yMap.observe (origin≠LOCAL 的增删改)
```

- 桥**本地 doc 而非 networkDoc**：本地编辑先落 IndexedDB outbox（离线可用、
  durable-ack 前不丢），远端更新经 network→local→桥到 Store —— 这是选 B 的核心收益。
- Undo：`Y.UndoManager` 挂 records map，scope 限定桥接 origin；tldraw 自身的
  history API 需要用 `mergeRemoteChanges` 包一层避免远端变更进本地 undo 栈。
- Schema/迁移：`createTLSchema({ shapes, bindings }).migrations` 在桥加载 records 时
  跑一遍，旧版本 app 写的 record 自动迁移；服务端不校验 record 内容（和文本一样，DO 不解析）。

### 3.2 presence

白板光标/选区/相机走 **per-file awareness**（本轮已修好 v2 presence：user/path/instanceId
公告 + 跨文件 presence 通道）。tldraw 的 instance presence 模型与 awareness
天然对应，same-file 协作者直接可见；跨文件"谁在哪块板上"由协调器 presence 通道兜底。

### 3.3 素材（图片等）→ 现有二进制管线

粘贴/拖入图片时：**不走 tldraw 默认的 base64 内联**，而是上传为项目二进制文件
（`CollabBinaryV2Client.replace` → R2），asset record 的 `props.src` 指向项目内路径。
好处：R2 GC、冲突副本、retention root 全部复用；`.tldr` 导出时引用关系不变。

### 3.4 落盘物化

`CollabProjectControllerV2` 的 disk observer 目前观察 Y.Text；board kind 增加一个
records observer：序列化为 `.tldr` JSON（带 `TLDRAW_FILE_HEADER` 版本头）写入工作区，
反向在打开时解析注入桥。离线导出/恢复（`exportRecovery`）对 board 同样有效
（Y.Doc update 即全部状态）。

## 4. 实施顺序

| 阶段 | 内容 | 依赖 |
|------|------|------|
| P0 | **许可证决策**（Hobby 水印 vs Commercial） | 无，阻塞一切 |
| P1 | kind="board" 协议 + 服务端放行；桥接模块 + 本地单人生成/编辑 `.tldr` | P0 |
| P2 | 协作联通：board 导入/导出、presence、undo scope | P1 |
| P3 | 素材走二进制管线；大板限流/体积复核 | P2 |
| P4 | 移动端/只读访客体验打磨 | P3 |

## 5. 风险与备注

- **桥接是唯一的新协议面**：record 级 LWW（Y.Map key 级）对 shape 属性并发编辑会
  整 record 覆盖，比 tldraw sync 的字段级合并粗 —— 实践中（两人拖同一个 shape）可接受，
  与文本 CRDT 的语义差异需要写入用户文档。
- **schema 版本漂移**：新旧客户端混用时，新 record 类型对旧客户端不可见（桥的
  未知类型过滤），与 tldraw sync 的 schema 校验行为一致地 fail-closed。
- **不要**在 Store 里存大图 base64 —— 会击穿 5MB 文档上限和 1MB 帧上限（v1 的
  22MB 教训）；素材一律走 P3 管线。
