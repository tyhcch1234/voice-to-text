# 語音轉文字 · iPhone 錄音 → 文字

一個純前端（static）嘅網頁工具：上載 iPhone「語音備忘錄」錄音檔（`.m4a`），即時轉成文字。
支援 **廣東話、English、普通話**，可匯出 **TXT** 及 **SRT 字幕**。

> 所有音訊解碼同語音辨識都喺瀏覽器內完成（WebAssembly + WebGPU），
> **音訊同文字都唔會上傳到任何伺服器**，唔需要 API key、唔需要後端。

## 功能

- 拖拉或點選多個錄音檔，自動排隊逐個處理（m4a / mp3 / wav / aac / caf / mp4 / ogg / webm）
- 語言切換：自動偵測 / 廣東話 / English / 普通話
- 模型選擇：輕量（~38MB）· 標準（~73MB）· 高精度（~237MB），首次下載後由瀏覽器快取
- 逐句時間碼，匯出 TXT 或 SRT 字幕
- 簡體轉繁體（香港用字，OpenCC）
- 自動使用 WebGPU 加速，唔支援時退回 CPU（WASM）

## 用法

1. iPhone「語音備忘錄」→ 揀錄音 → 分享 → 儲存到「檔案」
2. 用電腦或手機瀏覽器開本網頁，將檔案拖入或點選上載
3. 揀語言（廣東話 / English / 普通話）同模型，等轉錄完成
4. 複製文字，或下載 TXT / SRT

## 準確度說明（請先睇）

- 引擎係 OpenAI **Whisper**（透過 transformers.js 喺瀏覽器行 ONNX 版本）。
- Whisper 官方語言表只有「中文」，**無獨立嘅粵語 token**，所以「廣東話」模式實際係用中文模式處理。
  效果光譜：**英文 > 普通話 > 廣東話**。廣東話會出現書面語化、同音字 errors。
- 想廣東話準啲：揀「高精度」模型、錄音環境安靜、說話者唔好超過一米距離。
- 速度大約係錄音長度嘅 0.3–1.5 倍（視乎裝置同模型）。長錄音建議用電腦 Chrome / Edge。

## 技術

| 部分 | 說明 |
|---|---|
| 語音辨識 | [`@huggingface/transformers`](https://github.com/huggingface/transformers.js) v3.7.5 + Whisper ONNX（q8 量化） |
| 音訊處理 | Web Audio API，解碼後重採樣成 16kHz 單聲道 |
| 執行緒 | 辨識喺 Web Worker 進行，畫面唔會卡住 |
| 繁簡轉換 | [opencc-js](https://github.com/nk2028/opencc-js) |

## 本機執行

任何靜態伺服器都可以（因為用咗 ES module worker，唔可以直接 `file://` 開）：

```bash
python3 -m http.server 8000
# 開 http://localhost:8000
```

## 部署

GitHub Pages（main 分支 root）即可，唔需要 build step、唔需要任何 secret。

## 檔案

```
index.html   介面
styles.css   樣式
app.js       檔案處理、音訊解碼、佇列、匯出
worker.js    Whisper 模型載入與轉錄（Web Worker）
```
