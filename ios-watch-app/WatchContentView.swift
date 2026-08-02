import SwiftUI
import WatchKit

enum PTTState {
    case disconnected
    case waitingForPeer
    case ready
    case transmitting
    case receiving
}

struct WatchContentView: View {
    @EnvironmentObject var networkManager: NetworkManager
    @EnvironmentObject var audioEngine: AudioEngineManager
    
    @State private var channelCode: String = ""
    @State private var pttState: PTTState = .disconnected
    @State private var isShowingSetup: Bool = true
    @State private var crownValue: Double = 0.0
    
    var body: some View {
        NavigationStack {
            VStack {
                if isShowingSetup {
                    setupView
                } else {
                    walkieTalkieView
                }
            }
            .navigationTitle("Walkie-Talkie")
            .navigationBarTitleDisplayMode(.inline)
            .focusable()
            .digitalCrownRotation($crownValue, from: 0, through: 10, by: 1, sensitivity: .medium)
            .onReceive(networkManager.$currentState) { state in
                updateUIState(from: state)
            }
            .onReceive(audioEngine.$incomingAudioData) { data in
                if let data = data {
                    audioEngine.playAudioChunk(data)
                }
            }
        }
    }
    
    // MARK: - Setup View
    private var setupView: some View {
        VStack(spacing: 8) {
            Text("Enter Channel Code")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(.secondary)
            
            TextField("6-digit code", text: $channelCode)
                .font(.system(size: 18, weight: .bold, design: .monospaced))
                .multilineTextAlignment(.center)
                .frame(height: 38)
            
            HStack(spacing: 6) {
                Button(action: createChannel) {
                    Text("Create")
                        .font(.system(size: 12, weight: .bold))
                }
                .buttonStyle(.borderedProminent)
                .tint(.orange)
                
                Button(action: joinChannel) {
                    Text("Join")
                        .font(.system(size: 12, weight: .bold))
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(.horizontal, 4)
    }
    
    // MARK: - Walkie Talkie Main PTT View
    private var walkieTalkieView: some View {
        VStack(spacing: 6) {
            // Peer Status Bar
            HStack {
                Circle()
                    .fill(statusColor)
                    .frame(width: 8, height: 8)
                
                Text(statusText)
                    .font(.system(size: 11, weight: .medium))
                
                Spacer()
                
                Text("#\(channelCode)")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color.gray.opacity(0.15))
            .cornerRadius(8)
            
            Spacer()
            
            // Push-to-Talk Big Button
            Button(action: {}) {
                VStack(spacing: 4) {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 32))
                    
                    Text(buttonText)
                        .font(.system(size: 12, weight: .heavy))
                        .tracking(0.5)
                }
                .frame(width: 110, height: 110)
                .background(buttonGradient)
                .clipShape(Circle())
                .shadow(color: statusColor.opacity(0.5), radius: pttState == .transmitting || pttState == .receiving ? 12 : 4)
            }
            .buttonStyle(.plain)
            .disabled(pttState == .disconnected || pttState == .waitingForPeer)
            ._onButtonGesture(
                pressing: { isPressing in
                    if isPressing {
                        startTransmitting()
                    } else {
                        stopTransmitting()
                    }
                },
                perform: {}
            )
            
            Spacer()
            
            // Waveform meter
            AudioMeterView(level: audioEngine.audioLevel, color: statusColor)
                .frame(height: 16)
            
            // Disconnect button
            Button(action: disconnect) {
                Text("Leave Channel")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.red)
            }
            .buttonStyle(.plain)
            .padding(.bottom, 2)
        }
    }
    
    // MARK: - Actions & Helpers
    private func createChannel() {
        let code = String(Int.random(in: 100000...999999))
        self.channelCode = code
        WKInterfaceDevice.current().play(.click)
        networkManager.createRoom(code: code)
        isShowingSetup = false
    }
    
    private func joinChannel() {
        guard channelCode.count == 6 else { return }
        WKInterfaceDevice.current().play(.click)
        networkManager.joinRoom(code: channelCode)
        isShowingSetup = false
    }
    
    private func startTransmitting() {
        guard pttState == .ready else { return }
        pttState = .transmitting
        WKInterfaceDevice.current().play(.directionUp) // Haptic feedback on start speak
        networkManager.sendStartTalk()
        audioEngine.startRecording { chunkData in
            networkManager.sendAudioChunk(chunkData)
        }
    }
    
    private func stopTransmitting() {
        guard pttState == .transmitting else { return }
        pttState = .ready
        WKInterfaceDevice.current().play(.directionDown) // Haptic feedback on stop speak
        audioEngine.stopRecording()
        networkManager.sendStopTalk()
    }
    
    private func disconnect() {
        WKInterfaceDevice.current().play(.failure)
        audioEngine.stopRecording()
        networkManager.leaveRoom()
        isShowingSetup = true
        pttState = .disconnected
    }
    
    private func updateUIState(from networkState: NetworkManager.State) {
        switch networkState {
        case .disconnected:
            pttState = .disconnected
        case .waitingForPeer:
            pttState = .waitingForPeer
        case .paired:
            if pttState != .transmitting && pttState != .receiving {
                pttState = .ready
            }
        case .peerTalking:
            pttState = .receiving
            WKInterfaceDevice.current().play(.start)
        case .peerStopped:
            pttState = .ready
            WKInterfaceDevice.current().play(.stop)
        }
    }
    
    private var statusColor: Color {
        switch pttState {
        case .disconnected: return .red
        case .waitingForPeer: return .yellow
        case .ready: return .green
        case .transmitting: return .orange
        case .receiving: return .blue
        }
    }
    
    private var statusText: String {
        switch pttState {
        case .disconnected: return "Offline"
        case .waitingForPeer: return "Waiting..."
        case .ready: return "Paired"
        case .transmitting: return "Talking"
        case .receiving: return "Listening"
        }
    }
    
    private var buttonText: String {
        switch pttState {
        case .transmitting: return "TALKING"
        case .receiving: return "LISTENING"
        case .ready: return "HOLD TO TALK"
        default: return "WAITING"
        }
    }
    
    private var buttonGradient: LinearGradient {
        switch pttState {
        case .transmitting:
            return LinearGradient(colors: [.orange, .red], startPoint: .top, endPoint: .bottom)
        case .receiving:
            return LinearGradient(colors: [.cyan, .blue], startPoint: .top, endPoint: .bottom)
        case .ready:
            return LinearGradient(colors: [.green, .mint], startPoint: .top, endPoint: .bottom)
        default:
            return LinearGradient(colors: [.gray.opacity(0.4), .gray.opacity(0.2)], startPoint: .top, endPoint: .bottom)
        }
    }
}

struct AudioMeterView: View {
    var level: Float
    var color: Color
    
    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<12) { index in
                RoundedRectangle(cornerRadius: 2)
                    .fill(Float(index) / 12.0 < level ? color : Color.gray.opacity(0.3))
                    .frame(width: 4, height: max(4, CGFloat(index + 1) * 1.2))
            }
        }
    }
}
