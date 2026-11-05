using System;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Threading;
using System.Threading.Tasks;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Foundation;
using Windows.Storage.Streams;

namespace DoorStateClient;

class Program
{
    private static readonly Guid ServiceUuid = new("12345678-1234-1234-1234-123456789abc");
    private static readonly Guid CharacteristicUuid = new("12345678-1234-1234-1234-123456789abd");

    private static BluetoothLEDevice? _device;
    private static GattDeviceService? _service;
    private static GattCharacteristic? _characteristic;
    private static readonly object _gate = new();
    private static bool _isConnecting = false;

    private static CloudflareWorkerClient? _workerClient;
    private static BluetoothLEAdvertisementWatcher? _watcher;
    private static CancellationTokenSource? _appCts;
    private static TypedEventHandler<BluetoothLEAdvertisementWatcher, BluetoothLEAdvertisementReceivedEventArgs>? _advertisementHandler;

    static async Task Main(string[] args)
    {
        Console.WriteLine("ESP32S3 Reed Switch BLE Client");
        Console.WriteLine("Press Ctrl+C to exit");
        Console.WriteLine();

        var workerUrl = GetConfig(args, "worker", "DOOR_STATE_WORKER_URL");
        var workerToken = GetConfig(args, "token", "DOOR_STATE_TOKEN");

        if (!string.IsNullOrEmpty(workerUrl))
        {
            _workerClient = new CloudflareWorkerClient(workerUrl, workerToken);
            Console.WriteLine($"Cloudflare Worker: {workerUrl}");
        }
        else
        {
            Console.WriteLine("Cloudflare Worker not configured. Use --worker=<url> or DOOR_STATE_WORKER_URL.");
        }

        _appCts = new CancellationTokenSource();
        Console.CancelKeyPress += (s, e) =>
        {
            e.Cancel = true;
            _appCts.Cancel();
        };

        _watcher = new BluetoothLEAdvertisementWatcher
        {
            ScanningMode = BluetoothLEScanningMode.Active
        };

        _advertisementHandler = (s, e) => OnAdvertisementReceived(s, e, _appCts.Token);
        _watcher.Received += _advertisementHandler;
        _watcher.Start();
        Console.WriteLine("Scanning...");

        try
        {
            await Task.Delay(Timeout.Infinite, _appCts.Token);
        }
        catch (OperationCanceledException)
        {
        }

        Console.WriteLine("Exiting...");

        if (_watcher != null && _advertisementHandler != null)
        {
            _watcher.Received -= _advertisementHandler;
            _watcher.Stop();
        }

        await DisableNotificationsAsync();

        CleanupDevice();

        _workerClient?.Dispose();
    }

    private static string? GetConfig(string[] args, string argName, string envName)
    {
        var prefix = $"--{argName}=";
        return Environment.GetEnvironmentVariable(envName)
            ?? args.FirstOrDefault(a => a.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))?[prefix.Length..];
    }

    private static async void OnAdvertisementReceived(BluetoothLEAdvertisementWatcher sender, BluetoothLEAdvertisementReceivedEventArgs args, CancellationToken appToken)
    {
        lock (_gate)
        {
            if (_isConnecting || _device != null) return;
            _isConnecting = true;
        }

        try
        {
            // Service UUID がアドバタイズに含まれているか、デバイス名が一致するか
            if (!args.Advertisement.ServiceUuids.Contains(ServiceUuid) &&
                args.Advertisement.LocalName != "ESP32S3-ReedSwitch")
            {
                lock (_gate)
                {
                    _isConnecting = false;
                }
                return;
            }

            Console.WriteLine($"Found: {args.Advertisement.LocalName} [{args.BluetoothAddress:X}]");
            sender.Stop();

            // watcher が完全に停止するまで少し待つ
            await Task.Delay(200, appToken);

            var connected = await TryConnectAsync(sender, args.BluetoothAddress, appToken);
            if (!connected)
            {
                await RestartScanWithDelayAsync(sender, appToken);
            }
        }
        catch (OperationCanceledException)
        {
            // アプリ終了時
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error in advertisement handler: {ex.GetType().Name}: {ex.Message}");
            await RestartScanWithDelayAsync(sender, appToken);
        }
    }

    private static async Task<bool> TryConnectAsync(BluetoothLEAdvertisementWatcher sender, ulong bluetoothAddress, CancellationToken appToken)
    {
        const int maxRetries = 3;

        for (int attempt = 1; attempt <= maxRetries; attempt++)
        {
            if (appToken.IsCancellationRequested) return false;

            try
            {
                Console.WriteLine($"Connecting... (attempt {attempt}/{maxRetries})");

                var device = await RunWithTimeout(
                    BluetoothLEDevice.FromBluetoothAddressAsync(bluetoothAddress).AsTask(),
                    TimeSpan.FromSeconds(8),
                    "FromBluetoothAddressAsync",
                    appToken);

                if (device == null)
                {
                    Console.WriteLine("Connection returned null.");
                    continue;
                }

                lock (_gate)
                {
                    _device = device;
                }

                device.ConnectionStatusChanged += OnConnectionStatusChanged;

                var servicesResult = await RunWithTimeout(
                    device.GetGattServicesForUuidAsync(ServiceUuid).AsTask(),
                    TimeSpan.FromSeconds(10),
                    "GetGattServicesForUuidAsync",
                    appToken);

                if (servicesResult.Status != GattCommunicationStatus.Success || servicesResult.Services.Count == 0)
                {
                    Console.WriteLine($"Service discovery failed: {servicesResult.Status}");
                    CleanupDevice();
                    continue;
                }

                lock (_gate)
                {
                    _service = servicesResult.Services[0];
                }

                var charsResult = await RunWithTimeout(
                    _service.GetCharacteristicsForUuidAsync(CharacteristicUuid).AsTask(),
                    TimeSpan.FromSeconds(10),
                    "GetCharacteristicsForUuidAsync",
                    appToken);

                if (charsResult.Status != GattCommunicationStatus.Success || charsResult.Characteristics.Count == 0)
                {
                    Console.WriteLine($"Characteristic discovery failed: {charsResult.Status}");
                    CleanupDevice();
                    continue;
                }

                _characteristic = charsResult.Characteristics[0];
                _characteristic.ValueChanged += OnCharacteristicValueChanged;

                // 現在値を Read
                var readResult = await RunWithTimeout(
                    _characteristic.ReadValueAsync().AsTask(),
                    TimeSpan.FromSeconds(5),
                    "ReadValueAsync",
                    appToken);

                if (readResult.Status == GattCommunicationStatus.Success)
                {
                    HandleValue(readResult.Value, "Current");
                }

                // Notify を有効化
                var notifyResult = await RunWithTimeout(
                    _characteristic.WriteClientCharacteristicConfigurationDescriptorAsync(
                        GattClientCharacteristicConfigurationDescriptorValue.Notify).AsTask(),
                    TimeSpan.FromSeconds(5),
                    "WriteClientCharacteristicConfigurationDescriptorAsync",
                    appToken);

                if (notifyResult == GattCommunicationStatus.Success)
                {
                    Console.WriteLine("Notifications enabled.");
                    lock (_gate)
                    {
                        _isConnecting = false;
                    }
                    return true;
                }
                else
                {
                    Console.WriteLine($"Failed to enable notifications: {notifyResult}");
                    CleanupDevice();
                    continue;
                }
            }
            catch (OperationCanceledException) when (appToken.IsCancellationRequested)
            {
                return false;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Connection attempt {attempt} failed: {ex.GetType().Name}: {ex.Message}");
                CleanupDevice();

                if (attempt < maxRetries)
                {
                    Console.WriteLine("Retrying in 1 second...");
                    await Task.Delay(1000, appToken);
                }
            }
        }

        return false;
    }

    private static async Task<T> RunWithTimeout<T>(Task<T> task, TimeSpan timeout, string operationName, CancellationToken appToken)
    {
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(appToken);
        linkedCts.CancelAfter(timeout);

        try
        {
            return await task.WaitAsync(linkedCts.Token);
        }
        catch (OperationCanceledException) when (!appToken.IsCancellationRequested)
        {
            throw new TimeoutException($"Operation '{operationName}' timed out after {timeout.TotalSeconds}s");
        }
    }

    private static void OnConnectionStatusChanged(BluetoothLEDevice sender, object args)
    {
        Console.WriteLine($"Connection status: {sender.ConnectionStatus}");

        if (sender.ConnectionStatus == BluetoothConnectionStatus.Disconnected && _watcher != null)
        {
            // 切断されたら再接続のためにスキャン再開
            _ = Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(1500);
                    await RestartScanWithDelayAsync(_watcher, CancellationToken.None);
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"Reconnection error: {ex.Message}");
                }
            });
        }
    }

    private static void OnCharacteristicValueChanged(GattCharacteristic sender, GattValueChangedEventArgs args)
    {
        HandleValue(args.CharacteristicValue, "Changed");
    }

    private static void HandleValue(IBuffer buffer, string label)
    {
        var reader = DataReader.FromBuffer(buffer);
        byte value = reader.ReadByte();
        string state = value == 0 ? "CLOSED (magnet near)" : "OPEN (magnet away)";
        Console.WriteLine($"{label}: 0x{value:X2} - {state}");

        _workerClient?.SendAsync(value);
    }

    private static async Task DisableNotificationsAsync()
    {
        if (_characteristic == null) return;

        try
        {
            await _characteristic.WriteClientCharacteristicConfigurationDescriptorAsync(
                GattClientCharacteristicConfigurationDescriptorValue.None);
        }
        catch
        {
            // ignore
        }
    }

    private static void CleanupDevice()
    {
        lock (_gate)
        {
            if (_device != null)
            {
                _device.ConnectionStatusChanged -= OnConnectionStatusChanged;
            }

            _characteristic = null;
            _service?.Dispose();
            _service = null;
            _device?.Dispose();
            _device = null;
            _isConnecting = false;
        }
    }

    private static async Task RestartScanWithDelayAsync(BluetoothLEAdvertisementWatcher watcher, CancellationToken appToken)
    {
        CleanupDevice();

        try
        {
            await Task.Delay(1500, appToken);
            watcher.Start();
            Console.WriteLine("Scanning...");
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Failed to restart scan: {ex.Message}");
        }
    }
}

/// <summary>
/// Cloudflare Worker へ非同期で状態を送信するクライアント。
/// BLE イベントをブロックしないよう fire-and-forget で送信する。
/// </summary>
class CloudflareWorkerClient : IDisposable
{
    private readonly HttpClient _httpClient;
    private readonly string _url;

    public CloudflareWorkerClient(string url, string? token)
    {
        _url = url.TrimEnd('/');
        _httpClient = new HttpClient();
        _httpClient.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (!string.IsNullOrEmpty(token))
        {
            _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }
    }

    public void SendAsync(byte state)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                var payload = new { state };
                var response = await _httpClient.PostAsJsonAsync($"{_url}/api/status", payload);
                if (!response.IsSuccessStatusCode)
                {
                    var body = await response.Content.ReadAsStringAsync();
                    Console.WriteLine($"Worker POST failed: {(int)response.StatusCode} {body}");
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Worker POST error: {ex.Message}");
            }
        });
    }

    public void Dispose()
    {
        _httpClient.Dispose();
    }
}
