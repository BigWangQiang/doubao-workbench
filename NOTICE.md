# 第三方组件声明

- 桌面工作台继承自 [Doubao Studio](https://github.com/dorakoo/doubao-studio)，保留根目录的 MIT 许可证和原版权声明。
- `canvas-web` 源自 [Open AI Canvas](https://github.com/ddcat-ai/open-ai-canvas)，保留原始导入包所附的 [AGPL-3.0 许可证](canvas-web/LICENSE.upstream) 和上游后续发布的 [MIT 版权声明](canvas-web/LICENSE.open-ai-canvas).
- 画布内的 Face Cap 模型由 Face Cap 作者提供，来自 [three.js r185 示例](https://github.com/mrdoob/three.js/blob/r185/examples/webgl_morphtargets_face.html)。保留 [three.js 许可证](canvas-web/public/three/LICENSE.txt)。
- 画布随附的 [MediaPipe](https://github.com/google-ai-edge/mediapipe) 视觉组件和 [Basis Universal](https://github.com/BinomialLLC/basis_universal) 纹理解码器采用 Apache-2.0。完整许可证随 [MediaPipe](canvas-web/public/mediapipe/LICENSE.txt) 和 [Basis Universal](canvas-web/public/three/basis/LICENSE.txt) 文件提供。
- 语音头像采用 DiceBear 的 [Bottts Neutral](https://www.dicebear.com/styles/bottts-neutral/)，基于 Pablo Stanley 的 Bottts，保留图片中原有的作者和许可元数据。
- `vendor/network-core` 含 [Mihomo v1.19.31](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.31) 的 Windows x64 和 macOS arm64 官方二进制。对应源码与构建配置见 [该版本源码](https://github.com/MetaCubeX/mihomo/tree/v1.19.31)；许可证、版本和下载来源见 [组件目录](vendor/network-core)。
- 绘图功能依赖 [tldraw SDK](https://tldraw.dev/community/license)，生产环境使用所需的许可证由部署方提供。依赖项使用各自的许可证。品牌名称和标志归相应权利人所有。
