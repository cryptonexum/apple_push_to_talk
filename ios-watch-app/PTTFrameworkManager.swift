import Foundation
#if canImport(PushToTalk)
import PushToTalk

@available(iOS 16.0, watchOS 9.0, *)
class PTTFrameworkManager: NSObject, PTChannelManagerDelegate, PTChannelRestorer {
    static let shared = PTTFrameworkManager()
    
    private var channelManager: PTChannelManager?
    private var activeChannelUUID: UUID?
    
    func setupPTTChannel() {
        Task {
            do {
                channelManager = try await PTChannelManager.channelManager(
                    delegate: self,
                    restorer: self
                )
                print("PTChannelManager successfully initialized")
            } catch {
                print("Failed to initialize PTChannelManager: \(error)")
            }
        }
    }
    
    func joinPTTChannel(channelUUID: UUID, channelName: String) {
        activeChannelUUID = channelUUID
        let descriptor = PTChannelDescriptor(name: channelName, image: nil)
        
        channelManager?.requestBeginTransmitting(channelUUID: channelUUID)
    }
    
    func leavePTTChannel() {
        guard let uuid = activeChannelUUID else { return }
        channelManager?.leaveChannel(uuid: uuid)
        activeChannelUUID = nil
    }
    
    // MARK: - PTChannelManagerDelegate
    func channelManager(_ channelManager: PTChannelManager, didActivate audioSession: AVAudioSession) {
        print("PushToTalk Audio Session Activated")
    }
    
    func channelManager(_ channelManager: PTChannelManager, didDeactivate audioSession: AVAudioSession) {
        print("PushToTalk Audio Session Deactivated")
    }
    
    func channelManager(_ channelManager: PTChannelManager, channelUUID: UUID, didBeginTransmittingFrom source: PTChannelTransmitRequestSource) {
        print("Began Transmitting via system PTT UI")
    }
    
    func channelManager(_ channelManager: PTChannelManager, channelUUID: UUID, didEndTransmittingFrom source: PTChannelTransmitRequestSource) {
        print("Ended Transmitting via system PTT UI")
    }
    
    func channelManager(_ channelManager: PTChannelManager, receivedTransientFBToken token: Data) {
        // Register PushToTalk APNs token with backend for background wakeups
    }
    
    // MARK: - PTChannelRestorer
    func channelDescriptor(for channelUUID: UUID) -> PTChannelDescriptor {
        return PTChannelDescriptor(name: "Walkie Talkie Room", image: nil)
    }
}
#endif
