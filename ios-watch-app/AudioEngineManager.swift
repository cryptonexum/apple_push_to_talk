import Foundation
import AVFoundation

class AudioEngineManager: ObservableObject {
    private var audioEngine: AVAudioEngine
    private var inputNode: AVAudioInputNode
    private var playerNode: AVAudioPlayerNode
    
    @Published var audioLevel: Float = 0.0
    @Published var incomingAudioData: Data? = nil
    
    private var isRecording = false
    private var onAudioChunkCallback: ((Data) -> Void)?
    
    init() {
        audioEngine = AVAudioEngine()
        inputNode = audioEngine.inputNode
        playerNode = AVAudioPlayerNode()
        
        setupAudioSession()
        setupPlayer()
    }
    
    private func setupAudioSession() {
        #if os(watchOS)
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
            try session.setActive(true)
        } catch {
            print("Failed to configure AVAudioSession: \(error)")
        }
        #endif
    }
    
    private func setupPlayer() {
        audioEngine.attach(playerNode)
        let mainMixer = audioEngine.mainMixerNode
        audioEngine.connect(playerNode, to: mainMixer, format: mainMixer.outputFormat(forBus: 0))
    }
    
    func startRecording(onChunk: @escaping (Data) -> Void) {
        guard !isRecording else { return }
        self.onAudioChunkCallback = onChunk
        self.isRecording = true
        
        let format = inputNode.outputFormat(forBus: 0)
        
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] (buffer, time) in
            guard let self = self, self.isRecording else { return }
            
            // Calculate audio level for waveform meter
            let level = self.calculateRMS(buffer: buffer)
            DispatchQueue.main.async {
                self.audioLevel = level
            }
            
            // Convert buffer to Data for network transmission
            if let data = self.pcmBufferToData(buffer: buffer) {
                self.onAudioChunkCallback?(data)
            }
        }
        
        do {
            if !audioEngine.isRunning {
                try audioEngine.start()
            }
        } catch {
            print("Audio engine start error: \(error)")
        }
    }
    
    func stopRecording() {
        guard isRecording else { return }
        isRecording = false
        inputNode.removeTap(onBus: 0)
        
        DispatchQueue.main.async {
            self.audioLevel = 0.0
        }
    }
    
    func playAudioChunk(_ data: Data) {
        guard let buffer = dataToPCMBuffer(data: data) else { return }
        
        do {
            if !audioEngine.isRunning {
                try audioEngine.start()
            }
            if !playerNode.isPlaying {
                playerNode.play()
            }
            playerNode.scheduleBuffer(buffer, at: nil, options: [], completionHandler: nil)
        } catch {
            print("Error playing audio chunk: \(error)")
        }
    }
    
    // MARK: - Audio Utilities
    private func calculateRMS(buffer: AVAudioPCMBuffer) -> Float {
        guard let channelData = buffer.floatChannelData?[0] else { return 0.0 }
        let frameLength = Int(buffer.frameLength)
        var sum: Float = 0.0
        
        for i in 0..<frameLength {
            sum += channelData[i] * channelData[i]
        }
        
        let rms = sqrt(sum / Float(max(1, frameLength)))
        return min(1.0, max(0.0, rms * 5.0)) // Scaled for UI meter
    }
    
    private func pcmBufferToData(buffer: AVAudioPCMBuffer) -> Data? {
        let channelCount = 1
        let channels = UnsafeBufferPointer(start: buffer.floatChannelData, count: channelCount)
        guard let floatData = channels[0] else { return nil }
        let length = Int(buffer.frameLength) * MemoryLayout<Float>.size
        return Data(bytes: floatData, count: length)
    }
    
    private func dataToPCMBuffer(data: Data) -> AVAudioPCMBuffer? {
        let format = inputNode.outputFormat(forBus: 0)
        let frameCount = UInt32(data.count / MemoryLayout<Float>.size)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return nil }
        
        buffer.frameLength = frameCount
        data.withUnsafeBytes { (rawBufferPointer) in
            if let baseAddress = rawBufferPointer.baseAddress,
               let floatChannelData = buffer.floatChannelData?[0] {
                memcpy(floatChannelData, baseAddress, data.count)
            }
        }
        return buffer
    }
}
