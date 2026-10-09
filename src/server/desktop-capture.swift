import CoreImage
import CoreMedia
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

final class Output: NSObject, SCStreamOutput, SCStreamDelegate {
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let quality = 0.82 as CFNumber
    private var last = CFAbsoluteTimeGetCurrent()

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferIsValid(sample), CMSampleBufferDataIsReady(sample), isComplete(sample) else { return }
        guard let buffer = sample.imageBuffer else { return }
        let now = CFAbsoluteTimeGetCurrent()
        if now - last < 0.16 { return }
        last = now
        let image = CIImage(cvPixelBuffer: buffer)
        guard let cgImage = context.createCGImage(image, from: image.extent) else { return }
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(dest, cgImage, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return }
        FileHandle.standardOutput.write(data as Data)
    }

    private func isComplete(_ sample: CMSampleBuffer) -> Bool {
        guard let array = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = array.first?[.status] as? Int else {
            return true
        }
        return SCFrameStatus(rawValue: raw) == .complete
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("桌面画面中断：\(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
guard let display = content.displays.max(by: { $0.width * $0.height < $1.width * $1.height }) else {
    fputs("找不到这台 Mac 的主屏幕\n", stderr)
    exit(1)
}
let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
let config = SCStreamConfiguration()
let targetWidth = 1920
let scale = Double(targetWidth) / Double(max(display.width, 1))
config.width = targetWidth
config.height = max(2, Int((Double(display.height) * scale).rounded(.down) / 2) * 2)
config.pixelFormat = kCVPixelFormatType_32BGRA
config.colorSpaceName = CGColorSpace.sRGB
config.showsCursor = true
config.minimumFrameInterval = CMTime(value: 1, timescale: 5)
config.queueDepth = 4
config.scalesToFit = true

let output = Output()
let stream = SCStream(filter: filter, configuration: config, delegate: output)
try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "desktop-capture"))
try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    stream.startCapture { error in
        if let error {
            continuation.resume(throwing: error)
        } else {
            continuation.resume()
        }
    }
}
try await Task.sleep(nanoseconds: .max)
