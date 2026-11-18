#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// リードスイッチ接続ピン
#define REED_SWITCH_PIN 19

// チャタリング防止用（ミリ秒）
#define DEBOUNCE_MS 50

// 開放中に経過秒数を通知する間隔（ミリ秒）
#define NOTIFY_INTERVAL_MS 1000

// BLE UUID
#define SERVICE_UUID        "12345678-1234-1234-1234-123456789abc"
#define CHARACTERISTIC_UUID "12345678-1234-1234-1234-123456789abd"

BLEServer *pServer = nullptr;
BLECharacteristic *pCharacteristic = nullptr;
bool deviceConnected = false;

uint8_t lastRawState = HIGH;
uint8_t currentState = HIGH;
unsigned long lastDebounceTime = 0;

// ドア（リードスイッチ）が開放されてからの経過時間管理
bool doorOpen = false;
unsigned long openedAt = 0;
unsigned long lastNotifyTime = 0;

// Arduino IDE の自動プロトタイプ生成がクラス内呼び出しに効かないため明示的に宣言
void publishState();

class MyServerCallbacks : public BLEServerCallbacks {
    void onConnect(BLEServer *server) {
      deviceConnected = true;
      Serial.println("Client connected");

      // 接続直後に現在値を通知しておく
      publishState();
      lastNotifyTime = millis();
    }

    void onDisconnect(BLEServer *server) {
      deviceConnected = false;
      Serial.println("Client disconnected");
    }
};

/**
 * Characteristic に現在の状態を書き込み、接続中なら通知する。
 *
 * ペイロード (5 bytes):
 *   [0]    state          0x00 = CLOSED, 0x01 = OPEN
 *   [1-4]  elapsedSeconds 開放してからの経過秒数 (uint32, little-endian)
 */
void publishState() {
  uint32_t elapsed = 0;
  if (doorOpen) {
    elapsed = (millis() - openedAt) / 1000UL;
  }

  uint8_t payload[5];
  payload[0] = doorOpen ? 0x01 : 0x00;
  payload[1] = (uint8_t)(elapsed & 0xFF);
  payload[2] = (uint8_t)((elapsed >> 8) & 0xFF);
  payload[3] = (uint8_t)((elapsed >> 16) & 0xFF);
  payload[4] = (uint8_t)((elapsed >> 24) & 0xFF);

  pCharacteristic->setValue(payload, sizeof(payload));

  if (deviceConnected) {
    pCharacteristic->notify();
  }
}

void setup() {
  Serial.begin(115200);
  while (!Serial) { ; }
  delay(1000);

  Serial.println("Starting ESP32S3 Reed Switch BLE service...");

  // GPIO19 を内部プルアップ付き入力に設定
  pinMode(REED_SWITCH_PIN, INPUT_PULLUP);

  // BLE 初期化
  BLEDevice::init("ESP32S3-ReedSwitch");
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  // GATT サービス作成
  BLEService *pService = pServer->createService(SERVICE_UUID);

  // Characteristic 作成: Read + Notify
  pCharacteristic = pService->createCharacteristic(
      CHARACTERISTIC_UUID,
      BLECharacteristic::PROPERTY_READ |
      BLECharacteristic::PROPERTY_NOTIFY);

  // 通知有効化用ディスクリプタ
  pCharacteristic->addDescriptor(new BLE2902());

  // 初期値を設定
  uint8_t initialValue = digitalRead(REED_SWITCH_PIN);
  currentState = initialValue;
  lastRawState = initialValue;
  doorOpen = (initialValue == HIGH);
  openedAt = millis();
  lastNotifyTime = millis();
  publishState();

  pService->start();

  // アドバタイジング開始
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.println("Ready. Advertising started.");
  Serial.printf("Initial state: %s (HIGH=open, LOW=closed)\n", doorOpen ? "OPEN" : "CLOSED");
}

void loop() {
  uint8_t reading = digitalRead(REED_SWITCH_PIN);

  // チャタリング除去
  if (reading != lastRawState) {
    lastDebounceTime = millis();
  }

  if ((millis() - lastDebounceTime) > DEBOUNCE_MS) {
    if (reading != currentState) {
      currentState = reading;
      doorOpen = (currentState == HIGH);
      if (doorOpen) {
        openedAt = millis();
        Serial.println("State changed: OPEN (timer started)");
      } else {
        Serial.println("State changed: CLOSED (timer reset)");
      }

      publishState();
      lastNotifyTime = millis();
    }
  }

  lastRawState = reading;

  // 開放中は一定間隔で経過秒数を通知
  if (doorOpen && (millis() - lastNotifyTime >= NOTIFY_INTERVAL_MS)) {
    lastNotifyTime = millis();
    publishState();
    Serial.printf("Open for %lu s\n", (millis() - openedAt) / 1000UL);
  }

  // 切断時はアドバタイジングを継続
  if (!deviceConnected) {
    delay(500);
    BLEDevice::startAdvertising();
  }

  delay(10);
}
