// Generates synthetic test files for the engine (macOS only, uses AVFoundation).
//
//   swift make-fixtures.swift mov <out.mov> [seconds]
//       A healthy clip shaped like Sony XAVC S: H.264 1920x1080 25p, GOP of 12 frames
//       without B-frames, 48 kHz 16-bit big-endian stereo PCM ('twos').
//
//   swift make-fixtures.swift rsv <reference.mov> <out.RSV> <target MB> [cut fraction]
//       A synthetic .RSV built from the clip's samples, in the layout untrunc '-rsv-ben'
//       expects: per GOP a block of rtmd packets, the GOP's frames each preceded by an
//       H.264 AUD NAL, then the GOP's audio. The clip's GOPs are repeated until the file
//       reaches the target size, and the last GOP is cut to simulate a pulled battery.
//
// These files only exercise the parser and the I/O; they are not a substitute for
// real .RSV files from the camera.

import AVFoundation
import CoreVideo
import Foundation

let fps: Int32 = 25
let gop = 12
let sampleRate = 48000.0
let rtmdPacketSize = 19456
let rtmdPacketsPerGop = 3

func fail(_ msg: String) -> Never {
	FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
	exit(1)
}

// MARK: - mov

func makeMov(_ path: String, seconds: Int) {
	let url = URL(fileURLWithPath: path)
	try? FileManager.default.removeItem(at: url)
	guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mov) else { fail("cannot create writer") }
	writer.movieTimeScale = 25000

	let width = 1920, height = 1080
	let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
		AVVideoCodecKey: AVVideoCodecType.h264,
		AVVideoWidthKey: width,
		AVVideoHeightKey: height,
		AVVideoCompressionPropertiesKey: [
			AVVideoAverageBitRateKey: 100_000_000,
			AVVideoMaxKeyFrameIntervalKey: gop,
			AVVideoAllowFrameReorderingKey: false,
			AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
		],
	])
	video.mediaTimeScale = 25000
	video.expectsMediaDataInRealTime = false
	let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
		kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
		kCVPixelBufferWidthKey as String: width,
		kCVPixelBufferHeightKey as String: height,
	])

	var asbd = AudioStreamBasicDescription(
		mSampleRate: sampleRate, mFormatID: kAudioFormatLinearPCM,
		mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsBigEndian | kAudioFormatFlagIsPacked,
		mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 2,
		mBitsPerChannel: 16, mReserved: 0)
	let audio = AVAssetWriterInput(mediaType: .audio, outputSettings: [
		AVFormatIDKey: kAudioFormatLinearPCM,
		AVSampleRateKey: sampleRate,
		AVNumberOfChannelsKey: 2,
		AVLinearPCMBitDepthKey: 16,
		AVLinearPCMIsBigEndianKey: true,
		AVLinearPCMIsFloatKey: false,
		AVLinearPCMIsNonInterleaved: false,
	])
	audio.expectsMediaDataInRealTime = false

	writer.add(video)
	writer.add(audio)
	guard writer.startWriting() else { fail("startWriting: \(String(describing: writer.error))") }
	writer.startSession(atSourceTime: .zero)

	var rng = SystemRandomNumberGenerator()
	let frames = seconds * Int(fps)
	var fmt: CMAudioFormatDescription?
	CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil,
		magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &fmt)

	// Each input is fed from its own queue whenever the writer asks for more data;
	// feeding both from one loop deadlocks while the writer interleaves them.
	let audioPerFrame = Int(sampleRate) / Int(fps)
	var phase = 0.0
	let group = DispatchGroup()

	group.enter()
	var vi = 0
	video.requestMediaDataWhenReady(on: DispatchQueue(label: "video")) {
		while video.isReadyForMoreMediaData {
			if vi == frames { video.markAsFinished(); group.leave(); return }
			var pb: CVPixelBuffer?
			CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
			guard let buf = pb else { fail("no pixel buffer") }
			CVPixelBufferLockBaseAddress(buf, [])
			let base = CVPixelBufferGetBaseAddress(buf)!.assumingMemoryBound(to: UInt64.self)
			let words = CVPixelBufferGetDataSize(buf) / 8
			for w in 0..<words { base[w] = rng.next() }  // noise keeps frames large, like real footage
			CVPixelBufferUnlockBaseAddress(buf, [])
			adaptor.append(buf, withPresentationTime: CMTime(value: CMTimeValue(vi * 1000), timescale: 25000))
			vi += 1
		}
	}

	group.enter()
	var ai = 0
	audio.requestMediaDataWhenReady(on: DispatchQueue(label: "audio")) {
		while audio.isReadyForMoreMediaData {
		if ai == frames { audio.markAsFinished(); group.leave(); return }
		let i = ai
		ai += 1
		var pcm = [UInt8](repeating: 0, count: audioPerFrame * 4)
		for s in 0..<audioPerFrame {
			let v = Int16(8000 * sin(phase)); phase += 2 * Double.pi * 440 / sampleRate
			let be = UInt16(bitPattern: v).bigEndian
			withUnsafeBytes(of: be) { b in
				pcm[s*4] = b[0]; pcm[s*4+1] = b[1]; pcm[s*4+2] = b[0]; pcm[s*4+3] = b[1]
			}
		}
		var block: CMBlockBuffer?
		CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: pcm.count,
			blockAllocator: nil, customBlockSource: nil, offsetToData: 0, dataLength: pcm.count,
			flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
		CMBlockBufferReplaceDataBytes(with: pcm, blockBuffer: block!, offsetIntoDestination: 0, dataLength: pcm.count)
		var sb: CMSampleBuffer?
		CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block!,
			formatDescription: fmt!, sampleCount: audioPerFrame,
			presentationTimeStamp: CMTime(value: CMTimeValue(i * audioPerFrame), timescale: CMTimeScale(sampleRate)),
			packetDescriptions: nil, sampleBufferOut: &sb)
		audio.append(sb!)
		}
	}
	group.wait()
	let done = DispatchSemaphore(value: 0)
	writer.finishWriting { done.signal() }
	done.wait()
	if writer.status != .completed { fail("writer: \(String(describing: writer.error))") }
	print("wrote \(path)")
}

// MARK: - rsv

func readSamples(_ asset: AVURLAsset, _ type: AVMediaType) -> [Data] {
	guard let track = asset.tracks(withMediaType: type).first,
	      let reader = try? AVAssetReader(asset: asset) else { fail("cannot read \(type.rawValue)") }
	let out = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
	out.alwaysCopiesSampleData = true
	reader.add(out)
	reader.startReading()
	var samples: [Data] = []
	while let sb = out.copyNextSampleBuffer() {
		guard let bb = CMSampleBufferGetDataBuffer(sb) else { continue }
		var len = 0
		var ptr: UnsafeMutablePointer<CChar>?
		CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &len, dataPointerOut: &ptr)
		var d = Data(count: len)
		d.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(bb, atOffset: 0, dataLength: len, destination: $0.baseAddress!) }
		samples.append(d)
	}
	return samples
}

func makeRsv(ref: String, out: String, targetMB: Int, cut: Double) {
	let asset = AVURLAsset(url: URL(fileURLWithPath: ref))
	let frames = readSamples(asset, .video)
	let pcm = readSamples(asset, .audio).reduce(Data(), +)
	guard frames.count >= gop, pcm.count > 0 else { fail("reference too short") }

	let audioPerGop = gop * Int(sampleRate) / Int(fps) * 4
	let aud = Data([0x00, 0x00, 0x00, 0x02, 0x09, 0xf0])
	let gopsInRef = frames.count / gop
	let target = Int64(targetMB) << 20

	FileManager.default.createFile(atPath: out, contents: nil)
	guard let fh = FileHandle(forWritingAtPath: out) else { fail("cannot write \(out)") }
	var written: Int64 = 0
	var counter: UInt32 = 0
	var g = 0
	while true {
		var chunk = Data()
		for _ in 0..<rtmdPacketsPerGop {
			var pkt = Data(count: rtmdPacketSize)
			pkt[0] = 0x00; pkt[1] = 0x1c; pkt[2] = 0x01; pkt[3] = 0x00
			withUnsafeBytes(of: counter.bigEndian) { b in for k in 0..<4 { pkt[4+k] = b[k] } }
			pkt[8] = 0xf0; pkt[9] = 0x01; pkt[10] = 0x00; pkt[11] = 0x10
			pkt[12] = 0x55  // non-zero filler marker
			counter &+= 1
			chunk.append(pkt)
		}
		let refGop = g % gopsInRef
		for f in 0..<gop {
			chunk.append(aud)
			chunk.append(frames[refGop * gop + f])
		}
		let aStart = (refGop * audioPerGop) % max(1, pcm.count - audioPerGop)
		chunk.append(pcm.subdata(in: aStart..<(aStart + audioPerGop)))

		if written + Int64(chunk.count) >= target {
			// simulate the battery being pulled part-way through this GOP
			let keep = Int(Double(chunk.count) * (1 - cut))
			fh.write(chunk.prefix(keep))
			written += Int64(keep)
			break
		}
		fh.write(chunk)
		written += Int64(chunk.count)
		g += 1
	}
	fh.closeFile()
	print("wrote \(out): \(written) bytes, \(g) complete GOPs + 1 cut")
}

let a = CommandLine.arguments
if a.count >= 3 && a[1] == "mov" {
	makeMov(a[2], seconds: a.count > 3 ? Int(a[3])! : 10)
} else if a.count >= 5 && a[1] == "rsv" {
	makeRsv(ref: a[2], out: a[3], targetMB: Int(a[4])!, cut: a.count > 5 ? Double(a[5])! : 0.4)
} else {
	fail("usage: make-fixtures.swift mov <out.mov> [seconds] | rsv <ref.mov> <out.RSV> <target MB> [cut]")
}
