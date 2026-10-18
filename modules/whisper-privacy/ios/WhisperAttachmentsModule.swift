import ExpoModulesCore
import UIKit
import PDFKit
import AVFoundation
import ImageIO

public final class WhisperAttachmentsModule: Module {
  private var cleanupFailures = 0
  private func removeTemporary(_ url: URL) {
    guard FileManager.default.fileExists(atPath: url.path) else { return }
    do { try FileManager.default.removeItem(at: url) }
    catch { cleanupFailures += 1; NSLog("[Whisper cleanup] native-temp failure count=%d", cleanupFailures) }
  }
  private func invalid(_ message: String) -> NSError {
    NSError(domain: "WhisperAttachments", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
  public func definition() -> ModuleDefinition {
    Name("WhisperAttachments")
    AsyncFunction("preparePrivateStorage") { try self.preparePrivateStorage() }
    AsyncFunction("privacySelfCheck") { () throws -> [String: Any] in
      #if DEBUG
      let fm = FileManager.default
      let support = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
      let vault = support.appendingPathComponent("vault").resolvingSymlinksInPath()
      let cache = try fm.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
      var count = 0
      for root in [cache, fm.temporaryDirectory] {
        if let iterator = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) {
          for case let url as URL in iterator {
            if try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true && url.pathExtension != "wenc" { count += 1 }
          }
        }
      }
      let info = Bundle.main.infoDictionary ?? [:]
      return ["fileSharingEnabled": info["UIFileSharingEnabled"] as? Bool ?? true,
        "openingDocumentsInPlace": info["LSSupportsOpeningDocumentsInPlace"] as? Bool ?? true,
        "documentBrowserEnabled": info["UISupportsDocumentBrowser"] as? Bool ?? true,
        "documentTypesPresent": info["CFBundleDocumentTypes"] != nil,
        "vaultUnderApplicationSupport": vault.deletingLastPathComponent() == support.resolvingSymlinksInPath(),
        "vaultExcludedFromBackup": (try? vault.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup) == true,
        "potentialPlaintextTempFiles": count, "nativeCleanupFailures": self.cleanupFailures]
      #else
      throw self.invalid("Debug builds only")
      #endif
    }
    Function("protectTemporaryFile") { (uri: String) throws in
      try self.protectTemporaryFile(uri)
    }
    AsyncFunction("validateImageFile") { (uri: String) throws -> Bool in
      try self.protectTemporaryFile(uri)
      guard let url = URL(string: uri),
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0, size <= 64 * 1024 * 1024,
            let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
            CGImageSourceGetCount(source) == 1,
            let imageType = CGImageSourceGetType(source), ["public.jpeg", "public.png"].contains(imageType as String),
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
            let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
            let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
            width.intValue > 0, height.intValue > 0, width.intValue <= 8192, height.intValue <= 8192,
            width.int64Value * height.int64Value <= 16_000_000 else { throw self.invalid("Unsupported image dimensions or format") }
      return true
    }
    AsyncFunction("cleanTemporaryFiles") {
      let directory = FileManager.default.temporaryDirectory
      let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
      for file in files where file.lastPathComponent.hasPrefix("whisper-private-") {
        try FileManager.default.removeItem(at: file)
      }
    }
    AsyncFunction("renderPdfPage") { (base64: String, index: Int) throws -> [String: Any] in
      guard base64.count <= 4_000_000, let data = Data(base64Encoded: base64),
            let document = PDFDocument(data: data), document.pageCount > 0,
            document.pageCount <= 100, index >= 0, index < document.pageCount,
            let page = document.page(at: index) else { throw self.invalid("Invalid PDF or page") }
      let bounds = page.bounds(for: .mediaBox)
      guard bounds.width > 0, bounds.height > 0 else { throw self.invalid("Invalid page dimensions") }
      let scale = 1200 / max(bounds.width, bounds.height)
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      format.opaque = true
      let size = CGSize(width: max(1, bounds.width * scale), height: max(1, bounds.height * scale))
      let image = UIGraphicsImageRenderer(size: size, format: format).image { renderer in
        UIColor.white.setFill()
        renderer.fill(CGRect(origin: .zero, size: size))
        let context = renderer.cgContext
        context.translateBy(x: 0, y: size.height)
        context.scaleBy(x: scale, y: -scale)
        context.translateBy(x: -bounds.minX, y: -bounds.minY)
        page.draw(with: .mediaBox, to: context)
      }
      guard let jpeg = image.jpegData(compressionQuality: 0.85) else { throw self.invalid("Cannot render PDF") }
      return ["pageCount": document.pageCount, "image": jpeg.base64EncodedString()]
    }
    AsyncFunction("cleanVideoFile") { (inputUri: String) async throws -> String in
      guard let url = URL(string: inputUri), url.isFileURL else { throw self.invalid("Local video required") }
      let asset = AVURLAsset(url: url)
      let duration = try await asset.load(.duration)
      let composition = AVMutableComposition()
      for mediaType in [AVMediaType.video, AVMediaType.audio] {
        let tracks = try await asset.loadTracks(withMediaType: mediaType)
        guard tracks.count <= 1 else { throw self.invalid("Multiple media tracks unsupported") }
        if let source = tracks.first,
           let target = composition.addMutableTrack(withMediaType: mediaType, preferredTrackID: kCMPersistentTrackID_Invalid) {
          try target.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: source, at: .zero)
          target.preferredTransform = try await source.load(.preferredTransform)
        }
      }
      guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough),
            export.supportedFileTypes.contains(.mp4) else { throw self.invalid("Unsupported video codec") }
      try self.preparePrivateStorage()
      let output = FileManager.default.temporaryDirectory.appendingPathComponent("whisper-private-\(UUID().uuidString).mp4")
      var retained = false
      defer { if !retained { self.removeTemporary(output) } }
      export.outputURL = output
      export.outputFileType = .mp4
      export.metadata = []
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        export.exportAsynchronously { continuation.resume() }
      }
      guard export.status == .completed else { throw self.invalid("Video export failed") }
      try self.protectTemporaryFile(output.absoluteString)
      retained = true
      return output.absoluteString
    }
  }

  private func preparePrivateStorage() throws {
    let fm = FileManager.default
    let cache = try fm.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    for root in [cache, fm.temporaryDirectory] {
      try applyProtection(root)
      // Existing SDK-created content also receives protection; new children inherit it.
      if let iterator = fm.enumerator(at: root, includingPropertiesForKeys: [.isSymbolicLinkKey]) {
        for case let url as URL in iterator {
          if try url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true { try applyProtection(url) }
        }
      }
    }
  }
  private func applyProtection(_ input: URL) throws {
    var url = input
    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
  }

  private func protectTemporaryFile(_ uri: String) throws {
    guard let input = URL(string: uri), input.isFileURL else { throw invalid("Local temporary file required") }
    var url = input.standardizedFileURL.resolvingSymlinksInPath()
    let cache = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let roots = [cache, FileManager.default.temporaryDirectory].map { $0.standardizedFileURL.resolvingSymlinksInPath().path + "/" }
    guard roots.contains(where: { url.path.hasPrefix($0) }) else { throw invalid("Temporary file outside private cache") }
    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
  }
}
