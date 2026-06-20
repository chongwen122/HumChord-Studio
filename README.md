# Hum Pitch Studio

本项目是本地哼唱转 MIDI 工作台。当前版本默认使用本机 Basic Pitch / ONNX 高精度识别引擎，并叠加单声部 pYIN 音高轨迹校准，把录音转成更稳定的单旋律 MIDI；识别后仍可在网页里做节拍量化、调性修正、钢琴卷帘编辑、智能配和弦、试听和导出。

## 运行

```powershell
.\web\serve.ps1
```

然后打开：

```text
http://localhost:8765/
```

`serve.ps1` 会启动本地网页和 `/api/analyze` 识别接口。浏览器录音需要通过 `localhost` 打开，不建议直接双击 `index.html`。

## 安装识别引擎

当前机器已经安装好 Basic Pitch。如果换电脑或重建虚拟环境，运行：

```powershell
.\web\install_engine.ps1
```

脚本会安装 ONNX Runtime 版 Basic Pitch，避免在 Python 3.12 下拉取不兼容的旧 TensorFlow。

## 工作流

1. 设置 BPM、拍号和可选调性。
2. 录音或导入音频；默认开启 Space 手动分音。
3. 点击“生成 MIDI”，程序会优先使用本地 Basic Pitch 引擎。
4. 在“识别修音”页检查钢琴卷帘，可点选音符修改音高、起点、长度、力度。
5. 需要时点击“按节拍量化”或“按调性修正”。
6. 在“和弦编配”页生成和手动修改和弦。
7. 在“试听导出”页试听并下载 MIDI。

如果本地 Basic Pitch 服务不可用，网页会自动切换到内置备份识别引擎，保证工作台仍可使用。

Space 手动分音会尽量保持一个有效标记对应一个音符；没有稳定音高的标记会生成低置信度占位音，方便后续手动修改。

“按调性修正”会强制把所有调外音吸到调内，并优先参考原始音频的 pYIN 稳定音高来选择最近的调内音。

## 打包

网页包输出到：

```text
dist\HumPitchWeb.zip
```
