import Foundation

class NetworkManager: ObservableObject {
    enum State {
        case disconnected
        case waitingForPeer
        case paired
        case peerTalking
        case peerStopped
    }
    
    @Published var currentState: State = .disconnected
    private var webSocketTask: URLSessionWebSocketTask?
    private var serverURL: URL
    private var roomCode: String?
    
    init(serverURLString: String = "ws://localhost:3000") {
        self.serverURL = URL(string: serverURLString) ?? URL(string: "ws://localhost:3000")!
    }
    
    func connect() {
        let session = URLSession(configuration: .default)
        webSocketTask = session.webSocketTask(with: serverURL)
        webSocketTask?.resume()
        listenForMessages()
    }
    
    func disconnect() {
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        DispatchQueue.main.async {
            self.currentState = .disconnected
        }
    }
    
    func createRoom(code: String) {
        self.roomCode = code
        if webSocketTask == nil { connect() }
        
        let payload: [String: Any] = [
            "action": "create-room",
            "roomCode": code,
            "deviceType": "watchOS"
        ]
        sendJSON(payload)
        DispatchQueue.main.async {
            self.currentState = .waitingForPeer
        }
    }
    
    func joinRoom(code: String) {
        self.roomCode = code
        if webSocketTask == nil { connect() }
        
        let payload: [String: Any] = [
            "action": "join-room",
            "roomCode": code,
            "deviceType": "watchOS"
        ]
        sendJSON(payload)
    }
    
    func sendStartTalk() {
        let payload: [String: Any] = [
            "action": "start-talk",
            "roomCode": roomCode ?? ""
        ]
        sendJSON(payload)
    }
    
    func sendAudioChunk(_ chunk: Data) {
        guard let webSocketTask = webSocketTask else { return }
        let message = URLSessionWebSocketTask.Message.data(chunk)
        webSocketTask.send(message) { error in
            if let error = error {
                print("Failed to send audio data chunk: \(error)")
            }
        }
    }
    
    func sendStopTalk() {
        let payload: [String: Any] = [
            "action": "stop-talk",
            "roomCode": roomCode ?? ""
        ]
        sendJSON(payload)
    }
    
    func leaveRoom() {
        let payload: [String: Any] = [
            "action": "leave-room",
            "roomCode": roomCode ?? ""
        ]
        sendJSON(payload)
        disconnect()
    }
    
    private func sendJSON(_ dictionary: [String: Any]) {
        guard let webSocketTask = webSocketTask,
              let jsonData = try? JSONSerialization.data(withJSONObject: dictionary),
              let jsonString = String(data: jsonData, encoding: .utf8) else { return }
        
        let message = URLSessionWebSocketTask.Message.string(jsonString)
        webSocketTask.send(message) { error in
            if let error = error {
                print("WebSocket send error: \(error)")
            }
        }
    }
    
    private func listenForMessages() {
        webSocketTask?.receive { [weak self] result in
            guard let self = self else { return }
            
            switch result {
            case .failure(let error):
                print("WebSocket receive error: \(error)")
                DispatchQueue.main.async {
                    self.currentState = .disconnected
                }
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleIncomingText(text)
                case .data(let data):
                    self.handleIncomingAudioData(data)
                @unknown default:
                    break
                }
                
                // Continue listening loop
                self.listenForMessages()
            }
        }
    }
    
    private func handleIncomingText(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let event = json["event"] as? String else { return }
        
        DispatchQueue.main.async {
            switch event {
            case "peer-joined":
                self.currentState = .paired
            case "peer-left":
                self.currentState = .waitingForPeer
            case "peer-start-talk":
                self.currentState = .peerTalking
            case "peer-stop-talk":
                self.currentState = .peerStopped
            default:
                break
            }
        }
    }
    
    private func handleIncomingAudioData(_ data: Data) {
        // Broadcast audio chunk to audioEngine listener
        NotificationCenter.default.post(name: .didReceiveAudioChunk, object: data)
    }
}

extension Notification.Name {
    static let didReceiveAudioChunk = Notification.Name("didReceiveAudioChunk")
}
