import AVFoundation
import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow, NSDraggingDestination {
  private var desktopMediaChannel: FlutterMethodChannel?

  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    var windowFrame = self.frame
    let didResizeDefault = windowFrame.width < 900 || windowFrame.height < 640
    if didResizeDefault {
      windowFrame.size = NSSize(width: 980, height: 700)
    }
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)
    if didResizeDefault {
      self.center()
    }

    RegisterGeneratedPlugins(registry: flutterViewController)

    let channel = FlutterMethodChannel(
      name: "psyber/desktop_media",
      binaryMessenger: flutterViewController.engine.binaryMessenger
    )
    channel.setMethodCallHandler { [weak self] call, result in
      self?.handleDesktopMediaCall(call, result: result)
    }
    self.desktopMediaChannel = channel
    self.registerForDraggedTypes([.fileURL])

    super.awakeFromNib()
    self.title = "Psyber"
    self.titleVisibility = .hidden
    self.titlebarAppearsTransparent = true
    self.styleMask.insert(.fullSizeContentView)
    self.minSize = NSSize(width: 420, height: 560)
  }

  private func handleDesktopMediaCall(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "readClipboardMedia":
      result(readClipboardMedia())
    case "extractVideoFrames":
      guard let args = call.arguments as? [String: Any],
            let path = args["path"] as? String else {
        result(nil)
        return
      }
      let maxFrames = (args["maxFrames"] as? Int) ?? 4
      extractVideoFrames(path: path, maxFrames: maxFrames, result: result)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func readClipboardMedia() -> [String: Any]? {
    let pb = NSPasteboard.general
    if let urls = pb.readObjects(forClasses: [NSURL.self], options: [
      .urlReadingFileURLsOnly: true
    ]) as? [URL], !urls.isEmpty {
      let paths = urls.map { $0.path }
      if !paths.isEmpty {
        return ["filePaths": paths]
      }
    }
    if let pngData = pb.data(forType: .png) {
      return [
        "bytes": FlutterStandardTypedData(bytes: pngData),
        "filename": "clipboard.png",
        "mimeType": "image/png",
      ]
    }
    if let tiffData = pb.data(forType: .tiff),
       let bitmap = NSBitmapImageRep(data: tiffData),
       let pngData = bitmap.representation(using: .png, properties: [:]) {
      return [
        "bytes": FlutterStandardTypedData(bytes: pngData),
        "filename": "clipboard.png",
        "mimeType": "image/png",
      ]
    }
    return nil
  }

  private func extractVideoFrames(path: String, maxFrames: Int, result: @escaping FlutterResult) {
    DispatchQueue.global(qos: .userInitiated).async {
      let url = URL(fileURLWithPath: path)
      let asset = AVURLAsset(url: url)
      let durationSec = CMTimeGetSeconds(asset.duration)
      guard durationSec.isFinite, durationSec > 0 else {
        DispatchQueue.main.async { result(nil) }
        return
      }

      let generator = AVAssetImageGenerator(asset: asset)
      generator.appliesPreferredTrackTransform = true
      generator.maximumSize = CGSize(width: 960, height: 960)
      generator.requestedTimeToleranceBefore = CMTime(seconds: 0.25, preferredTimescale: 600)
      generator.requestedTimeToleranceAfter = CMTime(seconds: 0.25, preferredTimescale: 600)

      let count = max(1, min(maxFrames, 6))
      var frames: [FlutterStandardTypedData] = []
      for i in 0..<count {
        let ratio = (Double(i) + 0.5) / Double(count)
        let t = CMTime(seconds: durationSec * ratio, preferredTimescale: 600)
        if let cgImage = try? generator.copyCGImage(at: t, actualTime: nil) {
          let rep = NSBitmapImageRep(cgImage: cgImage)
          if let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.78]) {
            frames.append(FlutterStandardTypedData(bytes: jpeg))
          }
        }
      }

      DispatchQueue.main.async {
        if frames.isEmpty {
          result(nil)
        } else {
          result([
            "durationSec": durationSec,
            "frames": frames,
          ])
        }
      }
    }
  }

  func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
    if hasSupportedDraggedFiles(sender) {
      desktopMediaChannel?.invokeMethod("onDragStateChanged", arguments: true)
      return .copy
    }
    return []
  }

  func draggingExited(_ sender: NSDraggingInfo?) {
    desktopMediaChannel?.invokeMethod("onDragStateChanged", arguments: false)
  }

  func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    desktopMediaChannel?.invokeMethod("onDragStateChanged", arguments: false)
    let urls = readDraggedFileUrls(sender)
    if urls.isEmpty { return false }
    desktopMediaChannel?.invokeMethod("onFilesDropped", arguments: urls.map { $0.path })
    return true
  }

  private func readDraggedFileUrls(_ sender: NSDraggingInfo) -> [URL] {
    let pb = sender.draggingPasteboard
    return (pb.readObjects(forClasses: [NSURL.self], options: [
      .urlReadingFileURLsOnly: true
    ]) as? [URL]) ?? []
  }

  private func hasSupportedDraggedFiles(_ sender: NSDraggingInfo) -> Bool {
    return !readDraggedFileUrls(sender).isEmpty
  }
}
