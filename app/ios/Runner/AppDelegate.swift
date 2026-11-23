import AVFoundation
import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)

    let storageChannel = FlutterMethodChannel(
      name: "psyber/storage",
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
    )
    storageChannel.setMethodCallHandler { call, result in
      if call.method == "getAppSupportDir" {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        result(dir?.path)
      } else {
        result(FlutterMethodNotImplemented)
      }
    }

    let qrChannel = FlutterMethodChannel(
      name: "psyber/qr",
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
    )
    qrChannel.setMethodCallHandler { [weak self] call, result in
      guard call.method == "scanQrCode" else {
        result(FlutterMethodNotImplemented)
        return
      }
      DispatchQueue.main.async {
        self?.presentQrScanner(result: result)
      }
    }
  }

  private func presentQrScanner(result: @escaping FlutterResult) {
    guard let rootVc = topViewController() else {
      result(nil)
      return
    }
    let scanner = PsyberQrScannerViewController { scanned in
      result(scanned)
    }
    scanner.modalPresentationStyle = .fullScreen
    rootVc.present(scanner, animated: true)
  }

  private func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let keyWindow = scenes.flatMap { $0.windows }.first { $0.isKeyWindow }
    var top = keyWindow?.rootViewController
    while let presented = top?.presentedViewController {
      top = presented
    }
    return top
  }
}

/// 轻量原生 AVFoundation 二维码扫描视图控制器（零第三方插件）。
private final class PsyberQrScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  private let onComplete: (String?) -> Void
  private let session = AVCaptureSession()
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private var finished = false

  init(onComplete: @escaping (String?) -> Void) {
    self.onComplete = onComplete
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    setupCamera()
    setupOverlay()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    previewLayer?.frame = view.bounds
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    if session.isRunning {
      session.stopRunning()
    }
  }

  private func setupCamera() {
    guard let device = AVCaptureDevice.default(for: .video),
          let input = try? AVCaptureDeviceInput(device: device),
          session.canAddInput(input) else {
      finish(with: nil)
      return
    }
    session.addInput(input)
    let output = AVCaptureMetadataOutput()
    guard session.canAddOutput(output) else {
      finish(with: nil)
      return
    }
    session.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
    output.metadataObjectTypes = [.qr]

    let preview = AVCaptureVideoPreviewLayer(session: session)
    preview.videoGravity = .resizeAspectFill
    preview.frame = view.bounds
    view.layer.addSublayer(preview)
    previewLayer = preview

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      self?.session.startRunning()
    }
  }

  private func setupOverlay() {
    let cancelButton = UIButton(type: .system)
    cancelButton.setTitle("取消", for: .normal)
    cancelButton.setTitleColor(.white, for: .normal)
    cancelButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .medium)
    cancelButton.backgroundColor = UIColor.black.withAlphaComponent(0.5)
    cancelButton.layer.cornerRadius = 18
    cancelButton.contentEdgeInsets = UIEdgeInsets(top: 8, left: 16, bottom: 8, right: 16)
    cancelButton.translatesAutoresizingMaskIntoConstraints = false
    cancelButton.addTarget(self, action: #selector(handleCancel), for: .touchUpInside)
    view.addSubview(cancelButton)

    let hintLabel = UILabel()
    hintLabel.text = "对准终端或桌面端设置页中的 Psyber 配对二维码"
    hintLabel.textColor = .white
    hintLabel.font = .systemFont(ofSize: 14, weight: .regular)
    hintLabel.textAlignment = .center
    hintLabel.numberOfLines = 0
    hintLabel.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(hintLabel)

    NSLayoutConstraint.activate([
      cancelButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
      cancelButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
      hintLabel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -36),
      hintLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
      hintLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
    ])
  }

  @objc private func handleCancel() {
    finish(with: nil)
  }

  func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard !finished,
          let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
          obj.type == .qr,
          let value = obj.stringValue,
          !value.isEmpty else {
      return
    }
    finish(with: value)
  }

  private func finish(with value: String?) {
    guard !finished else { return }
    finished = true
    if session.isRunning {
      session.stopRunning()
    }
    dismiss(animated: true) {
      self.onComplete(value)
    }
  }
}
