// micmonitor — prints {"running":true|false} JSON lines whenever any
// input-capable audio device's "running somewhere" state changes (i.e. some
// process starts or stops using a microphone). Used to detect that a meeting
// has started.
//
// Watches ALL devices with input streams, not just the default input: browsers
// and meeting apps keep their own mic selection (Meet remembers a previous
// choice, Safari can use AirPods/continuity mics), so capture often happens on
// a non-default device. Known trade-off: a combined input/output device (some
// BT headsets) reports "running" during pure playback too — acceptable for a
// dismissible suggestion.
//
// Run with --list to print each input device and its current state, for
// debugging detection issues.
import CoreAudio
import Foundation

func allDevices() -> [AudioObjectID] {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var size: UInt32 = 0
  let system = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
  return ids
}

func hasInputStreams(_ deviceID: AudioObjectID) -> Bool {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyStreams,
    mScope: kAudioDevicePropertyScopeInput,
    mElement: kAudioObjectPropertyElementMain
  )
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(deviceID, &addr, 0, nil, &size) == noErr else { return false }
  return size > 0
}

func isRunningSomewhere(_ deviceID: AudioObjectID) -> Bool {
  var running: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &running)
  return running != 0
}

func deviceName(_ deviceID: AudioObjectID) -> String {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioObjectPropertyName,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var name: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &name) == noErr,
        let cf = name?.takeRetainedValue()
  else { return "device \(deviceID)" }
  return cf as String
}

func anyInputRunning() -> Bool {
  // Enumerate every poll: devices come and go (AirPods, USB mics, aggregates).
  for device in allDevices() where hasInputStreams(device) {
    if isRunningSomewhere(device) { return true }
  }
  return false
}

if CommandLine.arguments.contains("--list") {
  for device in allDevices() where hasInputStreams(device) {
    print("\(deviceName(device)): running=\(isRunningSomewhere(device))")
  }
  exit(0)
}

func emit(_ running: Bool) {
  print("{\"running\":\(running)}")
  fflush(stdout)
}

var lastState = anyInputRunning()
emit(lastState)

// Poll instead of property listeners: survives device hot-plug (AirPods
// connecting, etc.) with far less bookkeeping, and 500 ms latency is fine here.
let timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
  let state = anyInputRunning()
  if state != lastState {
    lastState = state
    emit(state)
  }
}

RunLoop.main.add(timer, forMode: .common)
RunLoop.main.run()
