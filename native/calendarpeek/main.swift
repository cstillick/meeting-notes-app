// Prints upcoming (and just-started) calendar events as one JSON line, then
// exits. The app polls this to auto-record meetings; keeping it a one-shot
// helper means no long-lived EventKit process and a trivially testable
// contract: JSON out, exit 0 — or {"error":"access-denied"} and exit 2.
//
// Output shape:
//   [{"id","title","startMs","endMs","calendar","attendees","hasMeetingLink"}]
// All-day events are omitted; the window is [now-1h, now+HOURS] so an event
// that started before launch still shows up.
import EventKit
import Foundation

let store = EKEventStore()
let semaphore = DispatchSemaphore(value: 0)
var granted = false

if #available(macOS 14.0, *) {
  store.requestFullAccessToEvents { ok, _ in
    granted = ok
    semaphore.signal()
  }
} else {
  store.requestAccess(to: .event) { ok, _ in
    granted = ok
    semaphore.signal()
  }
}
_ = semaphore.wait(timeout: .now() + 60)

guard granted else {
  print("{\"error\":\"access-denied\"}")
  exit(2)
}

var hours = 12.0
var arguments = Array(CommandLine.arguments.dropFirst())
var index = 0
while index < arguments.count {
  if arguments[index] == "--hours", index + 1 < arguments.count, let value = Double(arguments[index + 1]) {
    hours = value
    index += 2
  } else {
    index += 1
  }
}

let start = Date().addingTimeInterval(-3600)
let end = Date().addingTimeInterval(hours * 3600)
let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
let events = store.events(matching: predicate)

let linkHosts = [
  "zoom.us", "meet.google.com", "teams.microsoft.com", "teams.live.com",
  "webex.com", "whereby.com", "gather.town", "around.co"
]

var out: [[String: Any]] = []
for event in events where !event.isAllDay {
  let haystack = [
    event.location ?? "",
    event.notes ?? "",
    event.url?.absoluteString ?? ""
  ].joined(separator: " ").lowercased()
  let hasMeetingLink = linkHosts.contains { haystack.contains($0) }
  out.append([
    "id": event.eventIdentifier ?? "",
    "title": event.title ?? "",
    "startMs": Int(event.startDate.timeIntervalSince1970 * 1000),
    "endMs": Int(event.endDate.timeIntervalSince1970 * 1000),
    "calendar": event.calendar?.title ?? "",
    "attendees": event.attendees?.count ?? 0,
    "hasMeetingLink": hasMeetingLink
  ])
}

let data = try JSONSerialization.data(withJSONObject: out)
print(String(data: data, encoding: .utf8)!)
