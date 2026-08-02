import SwiftUI

@main
struct WalkieTalkieWatchApp: App {
    @StateObject private var networkManager = NetworkManager()
    @StateObject private var audioEngine = AudioEngineManager()
    
    var body: some Scene {
        WindowGroup {
            WatchContentView()
                .environmentObject(networkManager)
                .environmentObject(audioEngine)
        }
    }
}
