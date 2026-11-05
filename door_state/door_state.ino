#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// リードスイッチ接続ピン
#define REED_SWITCH_PIN 19

// チャタリング防止用（ミリ秒）
#define DEBOUNCE_MS 50

// BLE UUID
#define SERVICE_UUID        "12345678-1234-1234-1234-123456789abc"
#define CHARACTERISTIC_UUID "12345678-1234-1234-1234-123456789abd"

BLEServer *pServer = nullptr;
BLECharacteristic *pCharacteristic = nullptr;
bool deviceConnected = false;

uint8_t lastRawState = HIGH;
uint8_t currentState = HIGH;
unsigned long lastDebounceTime = 0;

class MyServerCallbacks : public BLEServerCallbacks {
    void onConnect(BLEServer *server) {
      deviceConnected = true;
      Serial.println("Client connected");
    }

    void onDisconnect(BLEServer *server) {
      deviceConnected = false;
      Serial.println("Client disconnected");
    }
};

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
  pCharacteristic->setValue(&initialValue, 1);

  pService->start();

  // アドバタイジング開始
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.println("Ready. Advertising started.");
  Serial.printf("Initial state: %d (HIGH=open, LOW=closed)\n", initialValue);
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
      Serial.printf("State changed: %d\n", currentState);

      // Characteristic に新しい値を設定して通知
      pCharacteristic->setValue(&currentState, 1);
      pCharacteristic->notify();
    }
  }

  lastRawState = reading;

  // 切断時はアドバタイジングを継続
  if (!deviceConnected) {
    delay(500);
    BLEDevice::startAdvertising();
  }

  delay(10);
}
