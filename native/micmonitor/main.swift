// micmonitor — prints {"running":true|false} JSON lines whenever the default
// input device's "running somewhere" state changes (i.e. some process starts
// or stops using the microphone). Used to detect that a meeting has started.
import CoreAudio
import Foundation

func getDefaultInputDevice() -> AudioObjectID {
  var deviceID = AudioObjectID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &deviceID)
  return deviceID
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

func emit(_ running: Bool) {
  print("{\"running\":\(running)}")
  fflush(stdout)
}

var currentDevice = getDefaultInputDevice()
var lastState = isRunningSomewhere(currentDevice)
emit(lastState)

// Poll instead of property listeners: survives default-device changes (AirPods
// connecting, etc.) with far less bookkeeping, and 500 ms latency is fine here.
let timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
  let device = getDefaultInputDevice()
  if device != currentDevice {
    currentDevice = device
  }
  let state = isRunningSomewhere(currentDevice)
  if state != lastState {
    lastState = state
    emit(state)
  }
}

RunLoop.main.add(timer, forMode: .common)
RunLoop.main.run()
