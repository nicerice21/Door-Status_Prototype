# Door State Monitor

学生IoTプロジェクトのプロトタイプ。
リードスイッチでドアの開閉状態を検知し、ESP32S3 から BLE で通知します。
Windows CLI が BLE で受信して Cloudflare Workers へ送信し、
ブラウザから現在のドア状態を確認できます。

## システム構成

```
[リードスイッチ]
      |
      v
[ESP32S3 DevKitC-1]  -- BLE (GATT/Notify) -->  [Windows CLI (C#)]
                                                    |
                                                    | HTTPS POST
                                                    v
[ブラウザ]  <-- HTML/JSON --  [Cloudflare Workers + KV]
```

| コンポーネント | 役割 | 技術 |
|---|---|---|
| firmware | リードスイッチの状態を BLE GATT サービスで公開 | ESP32S3 / Arduino (PlatformIO) |
| client | BLE で受信し、Worker へ状態を送信 | C# / .NET 10 / WinRT BLE API |
| worker | 状態を KV に保存し、ステータスページを表示 | Cloudflare Workers / KV |

## ハードウェア

### 部品

- ESP32S3 DevKitC-1
- リードスイッチ（常開型）＋ マグネット

### 配線

| ESP32S3 | リードスイッチ |
|---|---|
| GPIO19 | 一端 |
| GND | もう一端 |

内部プルアップを使用するため、外付け抵抗は不要です。

> **注意**: ESP32-S3 では GPIO19 は USB_D- と共有ピンです。GPIO19 を GPIO として使用すると、オンボードのネイティブ USB ポートの機能に影響を与える場合があります。ESP32S3 DevKitC-1 では UART0 経由の USB シリアル変換（プログラミング/モニタ用、GPIO43/44）とは別系統なので、通常の書き込みやシリアルモニタは継続して使用できます。別のピン（GPIO4 など）を使用する場合は `firmware/door_state/door_state.ino` の `REED_SWITCH_PIN` を変更してください。

## ディレクトリ構成

```
door_state/
├── README.md                  # このファイル
├── firmware/                  # ESP32S3 ファームウェア
│   ├── platformio.ini         # PlatformIO 設定
│   └── door_state/
│       └── door_state.ino     # Arduino スケッチ
├── client/                    # Windows CLI クライアント
│   ├── DoorStateClient.csproj
│   └── Program.cs
└── worker/                    # Cloudflare Workers
    ├── index.js               # Worker スクリプト
    ├── wrangler.toml          # Wrangler 設定
    └── .dev.vars.example      # ローカル開発用トークン例
```

## BLE 仕様

- デバイス名: `ESP32S3-ReedSwitch`
- Service UUID: `12345678-1234-1234-1234-123456789abc`
- Characteristic UUID: `12345678-1234-1234-1234-123456789abd`
- Properties: Read, Notify

### 状態値

| 値 | 状態 |
|---|---|
| `0x01` (HIGH) | 接点開放（マグネット遠い） |
| `0x00` (LOW) | 接点導通（マグネット近い） |

※内部プルアップのため、接点開放時は HIGH、導通時は LOW になります。

## セットアップ

### 1. ファームウェア (firmware/)

**Arduino IDE**

1. `firmware/door_state/door_state.ino` を開く
2. ボード設定で **ESP32S3 Dev Module** を選択
3. シリアルポートを選択して書き込み

**PlatformIO**

```bash
cd firmware
pio run -t upload
pio device monitor
```

必要なライブラリは ESP32 Arduino Core に同梱されているため追加不要です。

### 2. Windows CLI (client/)

**必要条件**

- Windows 10 バージョン 2004 (build 19041) 以降
- .NET 10 SDK 以降（`client/DoorStateClient.csproj` の TargetFramework を変更すれば .NET 8 なども可）
- Bluetooth LE 対応アダプタ

**実行**

```bash
cd client
dotnet run
```

**動作**

```
Scanning...
Found: ESP32S3-ReedSwitch [XXXXXXXXXXXX]
Current: 0x01 - OPEN (magnet away)
Notifications enabled.
Changed: 0x00 - CLOSED (magnet near)
```

> **注意**: Windows で初めて BLE デバイスに接続する場合、ペアリングや Bluetooth アクセス許可が必要になることがあります。接続が失敗する場合は、Windows の「Bluetooth とその他のデバイス」設定から ESP32S3 をペアリングしてみてください。

### 3. Cloudflare Workers (worker/)

1. KV namespace を作成:

   ```bash
   cd worker
   wrangler kv:namespace create "DOOR_STATE"
   ```

2. `wrangler.toml` の `YOUR_KV_NAMESPACE_ID` を作成された ID に置き換え

3. 認証トークンを設定:

   ```bash
   wrangler secret put DOOR_STATE_TOKEN
   ```

4. デプロイ:

   ```bash
   wrangler deploy
   ```

5. デプロイ後の URL（例: `https://door-state-worker.<subdomain>.workers.dev`）を控える

### 4. CLI と Worker の連携

```bash
cd client

# 環境変数で指定
$env:DOOR_STATE_WORKER_URL = "https://door-state-worker.<subdomain>.workers.dev"
$env:DOOR_STATE_TOKEN = "your-secret-token"
dotnet run

# またはコマンドライン引数で指定
dotnet run -- --worker=https://door-state-worker.<subdomain>.workers.dev --token=your-secret-token
```

Worker のルート URL（`/`）をブラウザで開くと、現在のドア状態が表示されます（5 秒ごと自動更新）。

## Worker API

| Method | Path | 説明 |
|---|---|---|
| POST | `/api/status` | 状態を保存。Body: `{"state": 0\|1}`。`Authorization: Bearer <TOKEN>` が必要 |
| GET | `/api/status` | 最新状態を JSON で取得 |
| GET | `/` | 状態表示用 HTML ページ |

## 動作確認

1. ESP32S3 にファームウェアを書き込み、シリアルモニタで `Ready. Advertising started.` を確認
2. CLI を起動し、接続・Notify 有効化を確認
3. マグネットでリードスイッチを ON/OFF し、CLI とブラウザの両方で状態が変わることを確認

nRF Connect などの BLE スキャナーでも `ESP32S3-ReedSwitch` の Characteristic 値を直接確認できます。

## トラブルシューティング

### CLI で `A task was canceled.` が頻発する

Windows BLE スタックは接続タイムアウトやデバイス切断を `TaskCanceledException` で通知することがあります。CLI にはタイムアウト・リトライ・自動再接続を実装済みですが、それでも頻発する場合は以下を確認してください：

1. Windows の「Bluetooth とその他のデバイス」設定から ESP32S3 をペアリング
2. ESP32S3 が圏内にあり、電波妨害が少ない場所に配置
3. ESP32S3 のアンテナ近くに金属物がないか確認
4. PC の Bluetooth を OFF/ON、または Windows 再起動
5. ESP32 側の電源・スリープ状態を確認

### Worker に POST できない

- `DOOR_STATE_TOKEN` が Worker と CLI で一致しているか確認
- Worker のログを確認: `wrangler tail`
- `401 Unauthorized` の場合はトークン、`404` の場合は URL を確認

## 今後の改善案

- 状態変化の履歴を Workers KV / D1 に保存し、時系列グラフ表示
- ドアの開閉を LINE Notify / Slack へ通知
- 複数センサーの管理（デバイス ID ごとのステータス）
- ESP32 のディープスリープによる省電力化
- CLI の常駐化（Windows サービス / タスクスケジューラ登録）
