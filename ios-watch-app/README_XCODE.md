# Apple Watch Push-to-Talk Setup Guide (Xcode & Deployment)

This guide walks you through deploying the **Walkie-Talkie Swift app** to your physical Apple Watch or watchOS Simulator.

---

## 🛠️ Step 1: Open Xcode & Create a New Project
1. Open **Xcode** on your Mac.
2. Select **File > New > Project**.
3. Choose **watchOS > App**.
4. Set Project Details:
   - **Product Name**: `WalkieTalkie`
   - **Interface**: `SwiftUI`
   - **Language**: `Swift`
   - **Watch App Target**: Check *Include Watch App*.

---

## 📁 Step 2: Copy Code Files into the Xcode Watch App Target
Drag & drop the following files into the `WalkieTalkie Watch App` folder in Xcode:
- `WalkieTalkieWatchApp.swift`
- `WatchContentView.swift`
- `AudioEngineManager.swift`
- `NetworkManager.swift`
- `PTTFrameworkManager.swift`

---

## ⚙️ Step 3: Configure Capabilities & Entitlements

### 1. Microphone Usage Permission
In your watchOS App's `Info.plist` (or `Target > Info > Custom watchOS Target Properties`), add:
- **Key**: `NSMicrophoneUsageDescription` (`Privacy - Microphone Usage Description`)
- **Value**: *"Walkie-Talkie requires microphone access for real-time 1-to-1 Push-to-Talk audio voice streaming over internet."*

### 2. Background Modes (Audio & Push-to-Talk)
1. Select your target **WalkieTalkie Watch App** in Xcode project settings.
2. Go to **Signing & Capabilities** tab > click **+ Capability**.
3. Add **Background Modes**:
   - Check **Audio, AirPlay, and Picture in Picture**
   - Check **Push-to-Talk** (Requires iOS 16 / watchOS 9+ SDK)

---

## 🌐 Step 4: Connecting Watch to Backend Server
By default, `NetworkManager.swift` connects to `ws://localhost:3000`.
When testing on a **physical Apple Watch**, replace `localhost` with your Mac's Local IP address (e.g. `ws://192.168.1.50:3000`) or your deployed cloud server URL (e.g., `wss://your-walkie-talkie.onrender.com`).

---

## 🚀 Step 5: Build & Run on Apple Watch
1. Connect your iPhone and paired Apple Watch via USB/Wi-Fi to your Mac.
2. Select **WalkieTalkie Watch App > [Your Apple Watch Name]** in Xcode's scheme selector.
3. Click **Run (Cmd + R)**.
