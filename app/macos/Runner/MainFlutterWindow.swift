import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
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

    super.awakeFromNib()
    self.title = "Psyber"
    self.titleVisibility = .hidden
    self.titlebarAppearsTransparent = true
    self.styleMask.insert(.fullSizeContentView)
    self.minSize = NSSize(width: 420, height: 560)
  }
}
