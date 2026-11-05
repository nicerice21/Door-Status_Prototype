# ESP32S3 Reed Switch BLE GATT Service

ESP32S3 Dev-Kit の GPIO19 に接続したリードスイッチの状態を、BLE GATT サービスで公開します。

## 機能

- GPIO19 を内部プルアップ入力として使用
- リードスイッチの状態を 1 バイトの GATT Characteristic で公開
- 状態変化時に BLE Notify（通知）を送信
- チャタリング防止（50ms ディバウンス）

## 状態値

| 値 | 状態 |
|---|---|
| `0x01` (HIGH) | 接点開放（マグネット遠い） |
| `0x00` (LOW) | 接点導通（マグネット近い） |

※内部プルアップのため、接点開放時は HIGH、導通時は LOW になります。

## 配線

| ESP32S3 | リードスイッチ |
|---|---|
| GPIO19 | 一端 |
| GND | もう一端 |

> **注意**: ESP32-S3 では GPIO19 は USB_D- と共有ピンです。GPIO19 を GPIO として使用すると、オンボードの USB コントローラー（ネイティブ USB ポート）の機能に影響を与える場合があります。ESP32S3 DevKitC-1 では UART0 経由の USB シリアル変換（プログラミング/モニタ用、GPIO43/44）とは別系統なので、通常の書き込みやシリアルモニタは継続して使用できます。別のピン（GPIO4 など）を使用する場合は `REED_SWITCH_PIN` を変更してください。

## BLE UUID

- Service: `12345678-1234-1234-1234-123456789abc`
- Characteristic: `12345678-1234-1234-1234-123456789abd`
- Properties: Read, Notify

## 使い方

### Arduino IDE

1. `door_state/door_state.ino` を開く
2. ボード設定で **ESP32S3 Dev Module** を選択
3. シリアルポートを選択して書き込み

### PlatformIO

```bash
pio run -t upload
```

## 必要なライブラリ

- ESP32 Arduino Core に含まれる `BLEDevice.h` など

## 動作確認

nRF Connect や LightBlue などの BLE スキャナーで `ESP32S3-ReedSwitch` を探し、
Characteristic の値がマグネットでリードスイッチを ON/OFF するたびに変化することを確認してください。
